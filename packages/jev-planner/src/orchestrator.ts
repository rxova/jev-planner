import { finalPlanPrompt, initialPlanPrompt, listLabels, revisionPrompt } from './prompts.js'
import { validateTask } from './task.js'
import type {
  AgentName,
  JevJudge,
  JevVerdict,
  PlanCost,
  PlanMode,
  PlanOptions,
  PlanResult,
  PlanRound,
  PlanningAgent,
} from './types.js'

/** One agent's current plan. */
interface Draft {
  agent: PlanningAgent
  plan: string
}

/** One agent's call in a round, and the plan that stands in if the round drops it. */
interface RoundCall {
  agent: PlanningAgent
  prompt: string
  /** The plan kept if this agent is dropped; a draft round has none to fall back on. */
  fallback?: string
}

/** Above this, Jev is asking for a cross-review pass rather than merely allowing one. */
const NEEDS_ANOTHER_PASS = 0.65

/** Above this, Jev is saying the strongest plan is final as it stands: no merge needed. */
const STANDS_ALONE = 0.7

/** A round never returns fewer plans than this: below it, there is no collaboration left to judge. */
const MIN_PLANS = 2

/** What a `fast` round waits for a straggler once enough agents have answered. */
export const DEFAULT_STRAGGLER_GRACE_MS = 90_000

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

    const mode: PlanMode = options.mode ?? 'fast'
    const maxReviewRounds = options.maxReviewRounds ?? 2
    // `ultra` buys every agent's answer to every round, so it never stops waiting.
    const graceMs = mode === 'ultra' ? 0 : (options.stragglerGraceMs ?? DEFAULT_STRAGGLER_GRACE_MS)
    const cost: PlanCost = {
      mode,
      reviewRounds: 0,
      synthesized: false,
      agentCalls: 0,
      jevCalls: 0,
      dropped: [],
    }

    const stage = options.onStage ?? (() => undefined)
    let round = 0
    const report = async (
      stageName: PlanRound['stage'],
      plans: Record<AgentName, string>,
      verdict?: JevVerdict,
    ) => {
      round += 1
      await options.onRound?.({
        round,
        stage: stageName,
        plans,
        ...(verdict ? { verdict } : {}),
      })
    }
    const { onAgentProgress } = options
    const request = (agent: PlanningAgent, prompt: string, signal?: AbortSignal) => ({
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
      ...(signal ? { signal } : {}),
    })
    const generate = (agent: PlanningAgent, prompt: string, signal?: AbortSignal) => {
      cost.agentCalls += 1
      return agent.generate(request(agent, prompt, signal))
    }
    const runRound = (calls: readonly RoundCall[]) =>
      this.round(calls, generate, graceMs, (agent) => {
        cost.dropped.push(agent.name)
        stage(`${agent.label} is still working; the round goes on without it…`)
      })
    const revise = (drafts: readonly Draft[], feedback?: string) =>
      runRound(
        drafts.map((own) => ({
          agent: own.agent,
          fallback: own.plan,
          prompt: revisionPrompt({
            task: options.task,
            ownPlan: own.plan,
            peerPlans: drafts
              .filter((draft) => draft !== own)
              .map((draft) => ({ label: draft.agent.label, plan: draft.plan })),
            ...(feedback ? { feedback } : {}),
          }),
        })),
      )
    const judge = (drafts: readonly Draft[], judged: 'draft' | 'review') => {
      cost.jevCalls += 1
      return this.jev.judge({
        task: options.task,
        stage: judged,
        plans: drafts.map(({ agent, plan }) => ({ agent: agent.name, label: agent.label, plan })),
        ...(options.jevModel ? { model: options.jevModel } : {}),
      })
    }
    const crossReview = (count: number) => `Cross-reviewing the ${String(count)} drafts…`

    stage(`Drafting independent plans with ${listLabels(labelsOf(this.agents))}…`)
    let drafts = await runRound(
      this.agents.map((agent) => ({
        agent,
        prompt: initialPlanPrompt(
          options.task,
          labelsOf(this.agents.filter((peer) => peer !== agent)),
        ),
      })),
    )

    let verdict: JevVerdict
    if (mode === 'ultra' && maxReviewRounds > 0) {
      // Every agent reads every other draft, whatever the drafts turned out to be.
      await report('draft', byName(drafts))
      stage(crossReview(drafts.length))
      drafts = await revise(drafts)
      cost.reviewRounds = 1
      stage('Asking Jev for typed quality and routing decisions…')
      verdict = await judge(drafts, 'review')
      await report('review', byName(drafts), verdict)
    } else {
      // Judge the drafts first: a cross-review that would change nothing is a
      // whole round of agent calls, and Jev answers for the price of one call.
      stage('Asking Jev for typed quality and routing decisions…')
      verdict = await judge(drafts, 'draft')
      await report('draft', byName(drafts), verdict)
    }

    while (
      cost.reviewRounds < maxReviewRounds &&
      verdict.needsAnotherPassProbability >= NEEDS_ANOTHER_PASS
    ) {
      stage(
        cost.reviewRounds === 0
          ? crossReview(drafts.length)
          : 'Jev requested another cross-review pass…',
      )
      drafts = await revise(drafts, JSON.stringify(verdict, null, 2))
      cost.reviewRounds += 1
      stage('Re-evaluating the revised plans with Jev…')
      verdict = await judge(drafts, 'review')
      await report('review', byName(drafts), verdict)
    }

    // A plan may only be answered with whole once it has seen every other
    // agent's material: before a cross-review, the merge is the only place that
    // happens, so the synthesis call is not the run's to skip.
    const standsAlone =
      mode === 'fast' &&
      finalizerOverride === undefined &&
      cost.reviewRounds > 0 &&
      verdict.standsAloneProbability >= STANDS_ALONE
    const adopted = standsAlone ? this.strongest(drafts, verdict) : undefined

    if (adopted) {
      stage(`Adopting ${adopted.agent.label}'s plan: Jev judged it final as it stands…`)
      await report('final', { [adopted.agent.name]: adopted.plan }, verdict)
      return {
        plan: adopted.plan,
        verdict,
        finalizer: adopted.agent.name,
        drafts: byName(drafts),
        cost,
      }
    }

    const finalizer = finalizerOverride ?? this.agent(verdict.finalizer)
    stage(`Synthesizing the final plan with ${finalizer.label}…`)

    const finalPlan = await generate(
      finalizer,
      finalPlanPrompt({
        task: options.task,
        plans: drafts.map(({ agent, plan }) => ({ label: agent.label, plan })),
        verdict: JSON.stringify(verdict, null, 2),
      }),
    )
    cost.synthesized = true

    await report('final', { [finalizer.name]: finalPlan }, verdict)

    return { plan: finalPlan, verdict, finalizer: finalizer.name, drafts: byName(drafts), cost }
  }

  /**
   * Every agent's plan for one round, in parallel.
   *
   * With a grace, the round stops waiting `graceMs` after half of the agents
   * have answered and aborts the rest, so one slow agent no longer sets the pace
   * of the round. An aborted agent keeps its plan from the round before, and an
   * agent whose plan the round cannot do without — a draft nobody can stand in
   * for, when dropping it would leave fewer than two plans — is waited for
   * anyway. Rejections are the caller's, as `Promise.all` would raise them,
   * except from a call this round aborted itself.
   */
  private round(
    calls: readonly RoundCall[],
    generate: (agent: PlanningAgent, prompt: string, signal?: AbortSignal) => Promise<string>,
    graceMs: number,
    onDrop: (agent: PlanningAgent) => void,
  ): Promise<Draft[]> {
    if (graceMs <= 0) {
      return Promise.all(
        calls.map(async ({ agent, prompt }) => ({ agent, plan: await generate(agent, prompt) })),
      )
    }

    return new Promise<Draft[]>((resolve, reject) => {
      interface Pending {
        call: RoundCall
        controller: AbortController
        plan?: string
        dropped?: true
      }
      const pending: Pending[] = calls.map((call) => ({ call, controller: new AbortController() }))
      const quorum = Math.max(1, Math.ceil(pending.length / 2))
      let answered = 0
      let timer: ReturnType<typeof setTimeout> | undefined
      let settled = false

      const finish = (callback: () => void): void => {
        if (settled) return
        settled = true
        if (timer !== undefined) clearTimeout(timer)
        callback()
      }

      const settleIfDone = (): void => {
        if (pending.some((entry) => entry.plan === undefined && entry.dropped === undefined)) return
        finish(() => {
          resolve(
            pending.flatMap(({ call, plan }) => {
              const answer = plan ?? call.fallback
              return answer === undefined ? [] : [{ agent: call.agent, plan: answer }]
            }),
          )
        })
      }

      const cutOff = (): void => {
        // What the round would answer with if it waited: one plan per call,
        // answered or not. Only dropping a call with nothing to fall back on
        // takes one away.
        let remaining = pending.length
        for (const entry of pending) {
          if (entry.plan !== undefined || entry.dropped !== undefined) continue
          if (entry.call.fallback === undefined) {
            if (remaining - 1 < MIN_PLANS) continue
            remaining -= 1
          }
          entry.dropped = true
          entry.controller.abort()
          onDrop(entry.call.agent)
        }
        settleIfDone()
      }

      for (const entry of pending) {
        generate(entry.call.agent, entry.call.prompt, entry.controller.signal).then(
          (plan) => {
            if (settled || entry.dropped !== undefined) return
            entry.plan = plan
            answered += 1
            if (timer === undefined && answered >= quorum) timer = setTimeout(cutOff, graceMs)
            settleIfDone()
          },
          (error: unknown) => {
            // A call this round aborted was already accounted for.
            if (entry.dropped !== undefined) return
            finish(() => {
              reject(error instanceof Error ? error : new Error(String(error)))
            })
          },
        )
      }
    })
  }

  /** The plan Jev called stronger, or the one it routed the merge to when it called them tied. */
  private strongest(drafts: readonly Draft[], verdict: JevVerdict): Draft | undefined {
    return (
      drafts.find(({ agent }) => agent.name === verdict.strongerPlan) ??
      drafts.find(({ agent }) => agent.name === verdict.finalizer)
    )
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
