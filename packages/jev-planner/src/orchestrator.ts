import { finalPlanPrompt, initialPlanPrompt, listLabels, revisionPrompt } from './prompts.js'
import { validateTask } from './task.js'
import type {
  AgentName,
  AgentSession,
  JevJudge,
  JevVerdict,
  PlanOptions,
  PlanResult,
  PlanRound,
  PlanningAgent,
  RunTimings,
} from './types.js'

/**
 * A call after the draft: a cross-review or the synthesis. It takes the
 * review effort, and a shorter prompt for an agent continuing its session.
 * `undefined` for a draft.
 */
type Later = { resumePrompt: string | undefined } | undefined

/** One agent's current plan. */
interface Draft {
  agent: PlanningAgent
  plan: string
}

const labelsOf = (agents: readonly PlanningAgent[]) => agents.map(({ label }) => label)
const byName = (drafts: readonly Draft[]) =>
  Object.fromEntries(drafts.map(({ agent, plan }) => [agent.name, plan]))

export class Planner {
  private readonly agents: readonly PlanningAgent[]

  /** Two or more agents with distinct names; each drafts, revises, and may finalize. */
  constructor(
    agents: readonly PlanningAgent[],
    private readonly jev: JevJudge,
  ) {
    if (agents.length < 2) throw new Error('A planner needs at least two agents')
    const names = agents.map(({ name }) => name)
    const duplicate = names.find((name, index) => names.indexOf(name) !== index)
    if (duplicate !== undefined) throw new Error(`Agent "${duplicate}" is listed more than once`)
    this.agents = [...agents]
  }

  async plan(options: PlanOptions): Promise<PlanResult> {
    // Before any agent call: a placeholder task would otherwise buy a full,
    // billed run that plans nothing.
    if (!options.allowAnyTask) validateTask(options.task)
    const finalizerOverride =
      options.finalizer === undefined ? undefined : this.agent(options.finalizer)

    const stage = options.onStage ?? (() => undefined)

    // Each round is timed from the end of the last one's report to its own, so
    // the time spent writing a round out is counted in neither.
    const runStart = performance.now()
    const timings: RunTimings = { totalMs: 0, rounds: [] }
    let roundStart = runStart
    let agentMs: Record<AgentName, number> = {}
    let jevMs: number | undefined
    const timed = async <T>(work: () => Promise<T>, record: (ms: number) => void): Promise<T> => {
      const start = performance.now()
      const result = await work()
      record(performance.now() - start)
      return result
    }

    let round = 0
    const report = async (
      stageName: PlanRound['stage'],
      plans: Record<AgentName, string>,
      verdict?: JevVerdict,
      selected?: true,
    ) => {
      round += 1
      const roundTimings = {
        totalMs: performance.now() - roundStart,
        agents: agentMs,
        ...(jevMs === undefined ? {} : { jevMs }),
      }
      timings.rounds.push({ round, stage: stageName, ...roundTimings })
      await options.onRound?.({
        round,
        stage: stageName,
        plans,
        ...(verdict ? { verdict } : {}),
        timings: roundTimings,
        ...(selected ? { selected } : {}),
      })
      roundStart = performance.now()
      agentMs = {}
      jevMs = undefined
    }
    const { onAgentProgress } = options
    // One conversation per agent, for this run only: a second run on the same
    // planner starts afresh.
    const resume = options.resume ?? true
    const sessions = new Map<PlanningAgent, AgentSession>(
      resume ? this.agents.map((agent) => [agent, {}]) : [],
    )
    const request = (agent: PlanningAgent, prompt: string, later: Later) => {
      const session = sessions.get(agent)
      const effort = later ? options.reviewEfforts?.[agent.name] : undefined
      return {
        prompt,
        ...(session
          ? { session, ...(later?.resumePrompt ? { resumePrompt: later.resumePrompt } : {}) }
          : {}),
        ...(effort === undefined ? {} : { effort }),
        cwd: options.cwd,
        timeoutMs: options.timeoutMs,
        ...(onAgentProgress
          ? {
              onProgress: (line: string) => {
                onAgentProgress(agent.name, line)
              },
            }
          : {}),
      }
    }
    const call = (agent: PlanningAgent, prompt: string, later: Later) =>
      timed(
        () => agent.generate(request(agent, prompt, later)),
        (ms) => {
          agentMs[agent.name] = ms
        },
      )
    const generate = async (
      agent: PlanningAgent,
      prompt: string,
      later: Later,
    ): Promise<Draft> => ({
      agent,
      plan: await call(agent, prompt, later),
    })
    const revise = (drafts: readonly Draft[], feedback?: string) =>
      Promise.all(
        drafts.map((own) => {
          const input = {
            task: options.task,
            ownPlan: own.plan,
            peerPlans: drafts
              .filter((draft) => draft !== own)
              .map((draft) => ({ label: draft.agent.label, plan: draft.plan })),
            ...(feedback ? { feedback } : {}),
          }
          return generate(own.agent, revisionPrompt(input), {
            resumePrompt: resume ? revisionPrompt({ ...input, resumed: true }) : undefined,
          })
        }),
      )
    const judge = (drafts: readonly Draft[]) =>
      timed(
        () =>
          this.jev.judge({
            task: options.task,
            plans: drafts.map(({ agent, plan }) => ({
              agent: agent.name,
              label: agent.label,
              plan,
            })),
            ...(options.jevModel ? { model: options.jevModel } : {}),
          }),
        (ms) => {
          jevMs = ms
        },
      )

    stage(`Drafting independent plans with ${listLabels(labelsOf(this.agents))}…`)
    const drafts = await Promise.all(
      this.agents.map((agent) =>
        generate(
          agent,
          initialPlanPrompt(options.task, labelsOf(this.agents.filter((peer) => peer !== agent))),
          undefined,
        ),
      ),
    )

    await report('draft', byName(drafts))

    stage(`Cross-reviewing the ${String(this.agents.length)} drafts…`)
    let revised = await revise(drafts)

    stage('Asking Jev for typed quality and routing decisions…')
    let verdict = await judge(revised)
    await report('review', byName(revised), verdict)

    if (verdict.needsAnotherPassProbability >= 0.65 && (options.maxReviewRounds ?? 2) > 1) {
      stage('Jev requested another cross-review pass…')
      revised = await revise(revised, JSON.stringify(verdict, null, 2))
      stage('Re-evaluating the revised plans with Jev…')
      verdict = await judge(revised)
      await report('review', byName(revised), verdict)
    }

    const stronger = options.selectStronger
      ? revised.find(({ agent }) => agent.name === verdict.strongerPlan)
      : undefined
    if (stronger) {
      stage(`Jev rated ${stronger.agent.label}'s plan stronger; using it without a synthesis…`)
      await report('final', { [stronger.agent.name]: stronger.plan }, verdict, true)
      timings.totalMs = performance.now() - runStart
      return {
        plan: stronger.plan,
        verdict,
        finalizer: stronger.agent.name,
        selected: true,
        drafts: byName(revised),
        timings,
      }
    }

    const finalizer = finalizerOverride ?? this.agent(verdict.finalizer)
    stage(`Synthesizing the final plan with ${finalizer.label}…`)

    const finalInput = {
      task: options.task,
      plans: revised.map(({ agent, plan }) => ({ label: agent.label, plan })),
      verdict: JSON.stringify(verdict, null, 2),
    }
    const finalPlan = await call(finalizer, finalPlanPrompt(finalInput), {
      resumePrompt: resume ? finalPlanPrompt({ ...finalInput, resumed: true }) : undefined,
    })

    await report('final', { [finalizer.name]: finalPlan }, verdict)
    timings.totalMs = performance.now() - runStart

    return {
      plan: finalPlan,
      verdict,
      finalizer: finalizer.name,
      drafts: byName(revised),
      timings,
    }
  }

  private agent(name: AgentName): PlanningAgent {
    const agent = this.agents.find((candidate) => candidate.name === name)
    if (!agent) {
      throw new Error(
        `"${name}" is not one of this planner's agents: ${this.agents.map((a) => a.name).join(', ')}`,
      )
    }
    return agent
  }
}
