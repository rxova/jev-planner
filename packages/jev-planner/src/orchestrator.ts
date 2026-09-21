import { finalPlanPrompt, initialPlanPrompt, listLabels, revisionPrompt } from './prompts.js'
import { validateTask } from './task.js'
import type {
  AgentName,
  JevJudge,
  JevVerdict,
  PlanOptions,
  PlanResult,
  PlanRound,
  PlanningAgent,
  RunTimings,
} from './types.js'

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
      })
      roundStart = performance.now()
      agentMs = {}
      jevMs = undefined
    }
    const { onAgentProgress } = options
    const request = (agent: PlanningAgent, prompt: string) => ({
      prompt,
      cwd: options.cwd,
      timeoutMs: options.timeoutMs,
      ...(onAgentProgress
        ? {
            onProgress: (line: string) => {
              onAgentProgress(agent.name, line)
            },
          }
        : {}),
    })
    const call = (agent: PlanningAgent, prompt: string) =>
      timed(
        () => agent.generate(request(agent, prompt)),
        (ms) => {
          agentMs[agent.name] = ms
        },
      )
    const generate = async (agent: PlanningAgent, prompt: string): Promise<Draft> => ({
      agent,
      plan: await call(agent, prompt),
    })
    const revise = (drafts: readonly Draft[], feedback?: string) =>
      Promise.all(
        drafts.map((own) =>
          generate(
            own.agent,
            revisionPrompt({
              task: options.task,
              ownPlan: own.plan,
              peerPlans: drafts
                .filter((draft) => draft !== own)
                .map((draft) => ({ label: draft.agent.label, plan: draft.plan })),
              ...(feedback ? { feedback } : {}),
            }),
          ),
        ),
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

    const finalizer = finalizerOverride ?? this.agent(verdict.finalizer)
    stage(`Synthesizing the final plan with ${finalizer.label}…`)

    const finalPlan = await call(
      finalizer,
      finalPlanPrompt({
        task: options.task,
        plans: revised.map(({ agent, plan }) => ({ label: agent.label, plan })),
        verdict: JSON.stringify(verdict, null, 2),
      }),
    )

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
