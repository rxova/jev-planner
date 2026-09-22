import {
  assignChecks,
  buildDisputes,
  parseChecks,
  parseCritique,
  parseReply,
} from '../debate/debate.js'
import {
  claimCheckPrompt,
  critiquePrompt,
  disputeFeedback,
  disputeSummary,
  finalPlanPrompt,
  initialPlanPrompt,
  listLabels,
  replyPrompt,
  revisionPrompt,
} from '../prompts/prompts.js'
import { validateTask } from '../task/task.js'
import type { AgentName, AgentSession, PlanningAgent } from '../provider/provider.types.js'
import type { Dispute, Reply, RoundDebate } from '../debate/debate.types.js'
import type { PlanJudge, Verdict } from '../questions/questions.types.js'
import type {
  PlanCost,
  PlanMode,
  PlanOptions,
  PlanResult,
  PlanRound,
  ReviewMode,
  RunTimings,
} from './orchestrator.types.js'
import type {
  Later,
  Draft,
  RoundCall,
  Generate,
  Accepted,
  DebateOutcome,
} from './orchestrator.types.js'

/** Above this, the judge is asking for a cross-review pass rather than merely allowing one. */
const NEEDS_ANOTHER_PASS = 0.65

/** Above this, the judge is saying the strongest plan is final as it stands: no merge needed. */
const STANDS_ALONE = 0.7

/**
 * In `fast` mode, at or above this the judge is accepting one draft, judged alone, as the answer. Lower
 * than `STANDS_ALONE`: in real runs the judge rated no plan above 0.59, so 0.7 never let a draft through.
 */
const ACCEPTED_ALONE = 0.5

/** A round never returns fewer plans than this: below it, there is no collaboration left to judge. */
const MIN_PLANS = 2

/** What a `balanced` round waits for a straggler once enough agents have answered. */
export const DEFAULT_STRAGGLER_GRACE_MS = 90_000

const labelsOf = (agents: readonly PlanningAgent[]) => agents.map(({ label }) => label)
const byName = (drafts: readonly Draft[]) =>
  Object.fromEntries(drafts.map(({ agent, plan }) => [agent.name, plan]))

export class Planner {
  private readonly agents: readonly PlanningAgent[]

  /** Two or more agents with distinct names; each drafts, revises, and may finalize. */
  constructor(
    agents: readonly PlanningAgent[],
    private readonly judge: PlanJudge,
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

    const mode: PlanMode = options.mode ?? 'balanced'
    const maxReviewRounds = options.maxReviewRounds ?? 2
    const reviewMode: ReviewMode =
      options.reviewMode ?? (options.claimChecks ? 'debate' : 'standard')
    if (options.claimChecks && reviewMode !== 'debate') {
      throw new Error("Claim checks run in the debate review: set reviewMode to 'debate'")
    }
    if (mode === 'fast' && reviewMode === 'debate') {
      throw new Error('The debate review is a review round, and fast mode has none')
    }
    if (reviewMode === 'debate' && maxReviewRounds < 1) {
      throw new Error('The debate review is a review round: maxReviewRounds must be at least 1')
    }
    // `ultra` buys every agent's answer to every round, so it never stops waiting.
    const graceMs = mode === 'ultra' ? 0 : (options.stragglerGraceMs ?? DEFAULT_STRAGGLER_GRACE_MS)
    const cost: PlanCost = {
      mode,
      reviewMode,
      reviewRounds: 0,
      synthesized: false,
      agentCalls: 0,
      judgeCalls: 0,
      dropped: [],
    }

    const stage = options.onStage ?? (() => undefined)

    // Each round is timed from the end of the last one's report to its own, so
    // the time spent writing a round out is counted in neither.
    const runStart = performance.now()
    const timings: RunTimings = { totalMs: 0, rounds: [] }
    let roundStart = runStart
    let agentMs: Record<AgentName, number> = {}
    let judgeMs: number | undefined
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
      extra: Pick<PlanRound, 'verdict' | 'selected' | 'artifacts' | 'debate'> = {},
    ) => {
      round += 1
      const roundTimings = {
        totalMs: performance.now() - roundStart,
        agents: agentMs,
        ...(judgeMs === undefined ? {} : { judgeMs }),
      }
      timings.rounds.push({ round, stage: stageName, ...roundTimings })
      await options.onRound?.({
        round,
        stage: stageName,
        plans,
        ...(extra.verdict ? { verdict: extra.verdict } : {}),
        timings: roundTimings,
        ...(extra.selected ? { selected: extra.selected } : {}),
        ...(extra.artifacts ? { artifacts: extra.artifacts } : {}),
        ...(extra.debate ? { debate: extra.debate } : {}),
      })
      roundStart = performance.now()
      agentMs = {}
      judgeMs = undefined
    }
    const { onAgentProgress } = options
    // One conversation per agent, for this run only: a second run on the same
    // planner starts afresh.
    const resume = options.resume ?? true
    const sessions = new Map<PlanningAgent, AgentSession>(
      resume ? this.agents.map((agent) => [agent, {}]) : [],
    )
    const request = (agent: PlanningAgent, prompt: string, later: Later, signal?: AbortSignal) => {
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
        ...(signal ? { signal } : {}),
      }
    }
    const generate: Generate = (agent, prompt, later, signal) => {
      cost.agentCalls += 1
      return timed(
        () => agent.generate(request(agent, prompt, later, signal)),
        (ms) => {
          // A call its round stopped waiting for belongs to no round's timings.
          if (signal?.aborted !== true) agentMs[agent.name] = ms
        },
      )
    }
    const runRound = (calls: readonly RoundCall[]) =>
      this.round(calls, generate, graceMs, (agent) => {
        cost.dropped.push(agent.name)
        stage(`${agent.label} is still working; the round goes on without it…`)
      })
    const revise = (drafts: readonly Draft[], feedback?: string, targeted?: true) =>
      runRound(
        drafts.map((own) => {
          const input = {
            task: options.task,
            ownPlan: own.plan,
            peerPlans: drafts
              .filter((draft) => draft !== own)
              .map((draft) => ({ label: draft.agent.label, plan: draft.plan })),
            ...(feedback ? { feedback } : {}),
            ...(targeted ? { targeted } : {}),
          }
          return {
            agent: own.agent,
            fallback: own.plan,
            prompt: revisionPrompt(input),
            later: {
              resumePrompt: resume ? revisionPrompt({ ...input, resumed: true }) : undefined,
            },
          }
        }),
      )
    const judge = (
      drafts: readonly Draft[],
      judged: 'solo' | 'draft' | 'review',
      disputes: readonly Dispute[] = [],
    ) => {
      cost.judgeCalls += 1
      return timed(
        () =>
          this.judge.judge({
            task: options.task,
            stage: judged,
            plans: drafts.map(({ agent, plan }) => ({
              agent: agent.name,
              label: agent.label,
              plan,
            })),
            ...(disputes.length > 0 ? { disputes } : {}),
            ...(options.judgeModel ? { model: options.judgeModel } : {}),
          }),
        (ms) => {
          // `fast` judges several drafts alone in one round; the round shows them all.
          judgeMs = (judgeMs ?? 0) + ms
        },
      )
    }
    const crossReview = (count: number) => `Cross-reviewing the ${String(count)} drafts…`
    const label = (name: AgentName) => this.agent(name).label
    const later = (prompt: (resumed: true | undefined) => string): Later => ({
      resumePrompt: resume ? prompt(true) : undefined,
    })

    // The debate review: each agent critiques the others, each author answers
    // the objections to its plan and revises it, the rejected objections become
    // disputes, and the judge rules on them along with its usual verdict.
    const debate = async (drafts: readonly Draft[]): Promise<DebateOutcome> => {
      const peersOf = (own: Draft) => drafts.filter((draft) => draft !== own)
      stage(`Collecting critiques of the ${String(drafts.length)} drafts…`)
      const critiques = await runRound(
        drafts.map((own) => {
          const input = {
            task: options.task,
            ownPlan: own.plan,
            peerPlans: peersOf(own).map(({ agent, plan }) => ({
              name: agent.name,
              label: agent.label,
              plan,
            })),
          }
          return {
            agent: own.agent,
            fallback: '',
            prompt: critiquePrompt(input),
            later: later((resumed) => critiquePrompt({ ...input, resumed })),
          }
        }),
      )
      const objections = critiques.flatMap(
        ({ agent, plan }) =>
          parseCritique(
            agent.name,
            plan,
            drafts.filter((draft) => draft.agent !== agent).map((draft) => draft.agent),
          ).objections,
      )
      await report('critique', byName(drafts), {
        artifacts: byName(critiques),
        debate: { objections },
      })

      stage('Asking each author to answer the objections to its plan…')
      const received = (own: Draft) =>
        objections
          .filter((objection) => objection.target === own.agent.name)
          .map((objection) => ({ ...objection, criticLabel: label(objection.critic) }))
      const answers = await runRound(
        drafts.map((own) => {
          const input = { task: options.task, ownPlan: own.plan, objections: received(own) }
          return {
            agent: own.agent,
            fallback: '',
            prompt: replyPrompt(input),
            later: later((resumed) => replyPrompt({ ...input, resumed })),
          }
        }),
      )
      const replies: Reply[] = []
      const revised = drafts.map((own) => {
        const answer = answers.find(({ agent }) => agent === own.agent)?.plan ?? ''
        const ids = received(own).map(({ id }) => id)
        const parsed = parseReply(own.agent.name, answer, ids, own.plan)
        replies.push(...parsed.replies)
        return { agent: own.agent, plan: parsed.plan }
      })
      const unanswered = objections
        .map(({ id }) => id)
        .filter((id) => !replies.some((reply) => reply.id === id))
      const built = buildDisputes(objections, replies)
      let { disputes } = built
      const { overflow } = built
      let claimChecks: RoundDebate['claimChecks']
      const record = (): RoundDebate => ({
        objections,
        replies,
        unanswered,
        disputes,
        overflow,
        ...(claimChecks ? { claimChecks } : {}),
      })

      let checks: Draft[] | undefined
      if (options.claimChecks) {
        const checkers = revised
          .filter(({ agent }) => agent.readsRepository === true)
          .map(({ agent }) => agent.name)
        const assigned = assignChecks(
          disputes.filter(({ repo }) => repo),
          checkers,
        )
        if (checkers.length < 2) {
          claimChecks = 'skipped'
          stage('Claim checks skipped: needs two agents that read the repository')
        } else if (assigned.size === 0) {
          claimChecks = 'skipped'
          stage('Claim checks skipped: no disputed claim about the repository')
        } else {
          await report('reply', byName(revised), { artifacts: byName(answers), debate: record() })
          stage(
            `Checking ${String([...assigned.values()].flat().length)} disputed claims against the repository…`,
          )
          const toCheck = [...assigned].map(([checker, claims]) => ({
            agent: this.agent(checker),
            claims,
            input: {
              task: options.task,
              claims: claims.map((dispute) => ({
                id: dispute.id,
                claim: dispute.claim,
                criticLabels: dispute.critics.map(label),
                authorLabel: label(dispute.target),
                rejections: dispute.rejections,
              })),
            },
          }))
          checks = await runRound(
            toCheck.map(({ agent, input }) => ({
              agent,
              fallback: '',
              prompt: claimCheckPrompt(input),
              later: later((resumed) => claimCheckPrompt({ ...input, resumed })),
            })),
          )
          const results = new Map(
            toCheck.flatMap(({ agent, claims }) => [
              ...parseChecks(
                agent.name,
                checks?.find((check) => check.agent === agent)?.plan ?? '',
                claims.map(({ id }) => id),
              ),
            ]),
          )
          disputes = disputes.map((dispute) => {
            const check = results.get(dispute.id)
            return check ? { ...dispute, check } : dispute
          })
          claimChecks = 'ran'
        }
      }

      stage(
        disputes.length > 0
          ? `Re-evaluating the revised plans and ${String(disputes.length)} disagreements with ${this.judge.name}…`
          : `Re-evaluating the revised plans with ${this.judge.name}…`,
      )
      const verdict = await judge(revised, 'review', disputes)
      await report(checks ? 'check' : 'review', byName(revised), {
        verdict,
        artifacts: byName(checks ?? answers),
        debate: record(),
      })
      return { drafts: revised, verdict, record: record(), disputes, overflow }
    }
    let debated: DebateOutcome | undefined

    const draftCalls: RoundCall[] = this.agents.map((agent) => ({
      agent,
      prompt: initialPlanPrompt(
        options.task,
        labelsOf(this.agents.filter((peer) => peer !== agent)),
      ),
      later: undefined,
    }))
    stage(`Drafting independent plans with ${listLabels(labelsOf(this.agents))}…`)

    let drafts: Draft[]
    let verdict: Verdict
    let accepted: Accepted | undefined
    if (mode === 'fast') {
      // Each draft is judged alone as it arrives; the first one the judge accepts ends the run.
      ;({ drafts, accepted } = await this.firstAccepted(
        draftCalls,
        generate,
        graceMs,
        (agent, winner) => {
          cost.dropped.push(agent.name)
          stage(
            winner
              ? `${this.judge.name} accepted ${winner.agent.label}'s draft; stopping ${agent.label}…`
              : `${agent.label} is still working; the round goes on without it…`,
          )
        },
        async (draft) => {
          stage(`${this.judge.name} is judging ${draft.agent.label}'s draft alone…`)
          const solo = await judge([draft], 'solo')
          if (solo.standsAloneProbability < ACCEPTED_ALONE) {
            stage(
              `${this.judge.name} judged ${draft.agent.label}'s draft not final on its own (${solo.standsAloneProbability.toFixed(2)})…`,
            )
          }
          return solo
        },
      ))
      if (accepted) {
        verdict = accepted.verdict
      } else {
        // No draft stands alone: judge them together to choose who merges them.
        stage(`Asking ${this.judge.name} for typed quality and routing decisions…`)
        verdict = await judge(drafts, 'draft')
      }
      await report('draft', byName(drafts), { verdict })
    } else {
      drafts = await runRound(draftCalls)
      if (mode === 'ultra' && maxReviewRounds > 0) {
        // Every agent reads every other draft, whatever the drafts turned out to be.
        await report('draft', byName(drafts))
        if (reviewMode === 'debate') {
          debated = await debate(drafts)
          ;({ drafts, verdict } = debated)
        } else {
          stage(crossReview(drafts.length))
          drafts = await revise(drafts)
          stage(`Asking ${this.judge.name} for typed quality and routing decisions…`)
          verdict = await judge(drafts, 'review')
          await report('review', byName(drafts), { verdict })
        }
        cost.reviewRounds = 1
      } else {
        // Judge the drafts first: a cross-review that would change nothing is a
        // whole round of agent calls, and the judge answers for the price of one call.
        stage(`Asking ${this.judge.name} for typed quality and routing decisions…`)
        verdict = await judge(drafts, 'draft')
        await report('draft', byName(drafts), { verdict })
      }
    }

    while (
      mode !== 'fast' &&
      cost.reviewRounds < maxReviewRounds &&
      verdict.needsAnotherPassProbability >= NEEDS_ANOTHER_PASS
    ) {
      if (reviewMode === 'debate' && debated === undefined) {
        debated = await debate(drafts)
        ;({ drafts, verdict } = debated)
        cost.reviewRounds += 1
        continue
      }
      if (debated) {
        // After a debate, a pass aims at what it left open, not at the whole verdict.
        const rulings = debated.verdict.disputes
        stage(`${this.judge.name} requested another pass on the open disagreements…`)
        drafts = await revise(
          drafts,
          disputeFeedback({
            disputes: debated.disputes,
            overflow: debated.overflow,
            verdict: rulings ? { ...verdict, disputes: rulings } : verdict,
            label,
          }),
          true,
        )
      } else {
        stage(
          cost.reviewRounds === 0
            ? crossReview(drafts.length)
            : `${this.judge.name} requested another cross-review pass…`,
        )
        drafts = await revise(drafts, JSON.stringify(verdict, null, 2))
      }
      cost.reviewRounds += 1
      stage(`Re-evaluating the revised plans with ${this.judge.name}…`)
      verdict = await judge(drafts, 'review')
      await report('review', byName(drafts), { verdict })
    }
    const debateRecord = debated ? { debate: debated.record } : {}

    // Outside fast mode, a plan may only be answered with whole once it has seen
    // every other agent's material: before a cross-review, the merge is the only
    // place that happens, so the synthesis call is not the run's to skip. A draft
    // fast mode accepted is the exception, and the mode's stated trade.
    const reviewed = cost.reviewRounds > 0
    const selected =
      reviewed && options.selectStronger
        ? drafts.find(({ agent }) => agent.name === verdict.strongerPlan)
        : undefined
    const standsAlone =
      reviewed &&
      mode === 'balanced' &&
      finalizerOverride === undefined &&
      verdict.standsAloneProbability >= STANDS_ALONE
    const adopted =
      accepted?.draft ?? selected ?? (standsAlone ? this.strongest(drafts, verdict) : undefined)

    if (adopted) {
      stage(
        adopted === selected
          ? `${this.judge.name} rated ${adopted.agent.label}'s plan stronger; using it without a synthesis…`
          : `Adopting ${adopted.agent.label}'s plan: ${this.judge.name} judged it final as it stands…`,
      )
      await report('final', { [adopted.agent.name]: adopted.plan }, { verdict, selected: true })
      timings.totalMs = performance.now() - runStart
      return {
        plan: adopted.plan,
        verdict,
        finalizer: adopted.agent.name,
        selected: true,
        drafts: byName(drafts),
        ...debateRecord,
        timings,
        cost,
      }
    }

    const finalizer = finalizerOverride ?? this.agent(verdict.finalizer)
    stage(`Synthesizing the final plan with ${finalizer.label}…`)

    const summary =
      debated && debated.disputes.length + debated.overflow.length > 0
        ? disputeSummary({
            disputes: debated.disputes,
            overflow: debated.overflow,
            rulings: debated.verdict.disputes ?? [],
            label,
          })
        : undefined
    const finalInput = {
      task: options.task,
      plans: drafts.map(({ agent, plan }) => ({ label: agent.label, plan })),
      verdict: JSON.stringify(verdict, null, 2),
      ...(summary === undefined ? {} : { disputes: summary }),
    }
    const finalPlan = await generate(finalizer, finalPlanPrompt(finalInput), {
      resumePrompt: resume ? finalPlanPrompt({ ...finalInput, resumed: true }) : undefined,
    })
    cost.synthesized = true

    await report('final', { [finalizer.name]: finalPlan }, { verdict })
    timings.totalMs = performance.now() - runStart

    return {
      plan: finalPlan,
      verdict,
      finalizer: finalizer.name,
      drafts: byName(drafts),
      ...debateRecord,
      timings,
      cost,
    }
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
    generate: Generate,
    graceMs: number,
    onDrop: (agent: PlanningAgent) => void,
  ): Promise<Draft[]> {
    if (graceMs <= 0) {
      return Promise.all(
        calls.map(async ({ agent, prompt, later }) => ({
          agent,
          plan: await generate(agent, prompt, later),
        })),
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
        generate(
          entry.call.agent,
          entry.call.prompt,
          entry.call.later,
          entry.controller.signal,
        ).then(
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

  /**
   * The draft round of `fast` mode: every agent drafts at once, and each draft
   * is handed to `judgeSolo` as it arrives, one at a time, in arrival order.
   * The first one whose verdict stands alone is accepted: the calls still
   * running are aborted and reported to `onDrop` with it, and the round
   * resolves with every draft that arrived, those still waiting to be judged
   * included. With none accepted, it resolves once every call has answered
   * and every draft has been judged.
   *
   * The grace works as in `round`: once half the agents have answered, the
   * rest get `graceMs`, and the round never cuts below two drafts. It is kept
   * apart from `round` so that `balanced` and `ultra` run exactly the code
   * they always have. An agent or the judge failing before a draft is accepted
   * aborts the calls still running and rejects the round.
   */
  private firstAccepted(
    calls: readonly RoundCall[],
    generate: Generate,
    graceMs: number,
    onDrop: (agent: PlanningAgent, accepted?: Draft) => void,
    judgeSolo: (draft: Draft) => Promise<Verdict>,
  ): Promise<{ drafts: Draft[]; accepted?: Accepted }> {
    return new Promise((resolve, reject) => {
      interface Pending {
        call: RoundCall
        controller: AbortController
        plan?: string
        dropped?: true
      }
      const pending: Pending[] = calls.map((call) => ({ call, controller: new AbortController() }))
      const quorum = Math.max(1, Math.ceil(pending.length / 2))
      const queue: Draft[] = []
      let answered = 0
      let judging = false
      let timer: ReturnType<typeof setTimeout> | undefined
      let settled = false

      const running = () =>
        pending.filter((entry) => entry.plan === undefined && entry.dropped === undefined)
      const finish = (callback: () => void): void => {
        if (settled) return
        settled = true
        if (timer !== undefined) clearTimeout(timer)
        callback()
      }
      const resolveWith = (accepted?: Accepted): void => {
        finish(() => {
          resolve({
            drafts: pending.flatMap(({ call, plan }) =>
              plan === undefined ? [] : [{ agent: call.agent, plan }],
            ),
            ...(accepted ? { accepted } : {}),
          })
        })
      }
      const fail = (error: unknown): void => {
        for (const entry of running()) {
          entry.dropped = true
          entry.controller.abort()
        }
        finish(() => {
          reject(error instanceof Error ? error : new Error(String(error)))
        })
      }

      const judgeNext = (): void => {
        if (settled || judging) return
        const draft = queue.shift()
        if (!draft) {
          if (running().length === 0) resolveWith()
          return
        }
        judging = true
        judgeSolo(draft).then((verdict) => {
          judging = false
          if (settled) return
          if (verdict.standsAloneProbability < ACCEPTED_ALONE) {
            judgeNext()
            return
          }
          for (const entry of running()) {
            entry.dropped = true
            entry.controller.abort()
            onDrop(entry.call.agent, draft)
          }
          resolveWith({ draft, verdict })
        }, fail)
      }

      const cutOff = (): void => {
        // Every call is a draft, and a draft has nothing to stand in for it.
        let remaining = pending.length
        for (const entry of running()) {
          if (remaining - 1 < MIN_PLANS) continue
          remaining -= 1
          entry.dropped = true
          entry.controller.abort()
          onDrop(entry.call.agent)
        }
        judgeNext()
      }

      for (const entry of pending) {
        const { agent, prompt, later } = entry.call
        generate(agent, prompt, later, entry.controller.signal).then(
          (plan) => {
            if (settled || entry.dropped !== undefined) return
            entry.plan = plan
            answered += 1
            if (graceMs > 0 && timer === undefined && answered >= quorum) {
              timer = setTimeout(cutOff, graceMs)
            }
            queue.push({ agent, plan })
            judgeNext()
          },
          (error: unknown) => {
            // A call this round aborted was already accounted for.
            if (entry.dropped !== undefined) return
            fail(error)
          },
        )
      }
    })
  }

  /** The plan the judge called stronger, or the one it routed the merge to when it called them tied. */
  private strongest(drafts: readonly Draft[], verdict: Verdict): Draft | undefined {
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
