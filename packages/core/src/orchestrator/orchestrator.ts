import { debateReview } from '../debate-review/debate-review.js'
import { findAgent, PlanRun } from '../plan-run/plan-run.js'
import { disputeFeedback, initialPlanPrompt, listLabels } from '../prompts/prompts.js'
import { ACCEPTED_ALONE, byName, firstAccepted } from '../round/round.js'
import { synthesize } from '../synthesis/synthesis.js'
import { validateTask } from '../task/task.js'
import type { DebateOutcome } from '../debate-review/debate-review.types.js'
import type { PlanningAgent } from '../provider/provider.types.js'
import type { PlanJudge, Verdict } from '../questions/questions.types.js'
import type { Accepted, Draft, RoundCall } from '../round/round.types.js'
import type { PlanMode, PlanOptions, PlanResult, ReviewMode } from './orchestrator.types.js'

/** Above this, the judge is asking for a cross-review pass rather than merely allowing one. */
const NEEDS_ANOTHER_PASS = 0.65

/** What a `balanced` round waits for a straggler once enough agents have answered. */
export const DEFAULT_STRAGGLER_GRACE_MS = 90_000

const labelsOf = (agents: readonly PlanningAgent[]) => agents.map(({ label }) => label)

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
      options.finalizer === undefined ? undefined : findAgent(this.agents, options.finalizer)

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
    const run = new PlanRun(this.agents, this.judge, options, { mode, reviewMode, graceMs })
    const { cost, stage } = run
    const judgeName = this.judge.name
    const crossReview = (count: number) => `Cross-reviewing the ${String(count)} drafts…`
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
      ;({ drafts, accepted } = await firstAccepted(
        draftCalls,
        run.generate,
        graceMs,
        (agent, winner) => {
          cost.dropped.push(agent.name)
          stage(
            winner
              ? `${judgeName} accepted ${winner.agent.label}'s draft; stopping ${agent.label}…`
              : `${agent.label} is still working; the round goes on without it…`,
          )
        },
        async (draft) => {
          stage(`${judgeName} is judging ${draft.agent.label}'s draft alone…`)
          const solo = await run.judge([draft], 'solo')
          if (solo.standsAloneProbability < ACCEPTED_ALONE) {
            stage(
              `${judgeName} judged ${draft.agent.label}'s draft not final on its own (${solo.standsAloneProbability.toFixed(2)})…`,
            )
          }
          return solo
        },
      ))
      if (accepted) {
        verdict = accepted.verdict
      } else {
        // No draft stands alone: judge them together to choose who merges them.
        stage(`Asking ${judgeName} for typed quality and routing decisions…`)
        verdict = await run.judge(drafts, 'draft')
      }
      await run.report('draft', byName(drafts), { verdict })
    } else {
      drafts = await run.runRound(draftCalls)
      if (mode === 'ultra' && maxReviewRounds > 0) {
        // Every agent reads every other draft, whatever the drafts turned out to be.
        await run.report('draft', byName(drafts))
        if (reviewMode === 'debate') {
          debated = await debateReview(run, drafts)
          ;({ drafts, verdict } = debated)
        } else {
          stage(crossReview(drafts.length))
          drafts = await run.revise(drafts)
          stage(`Asking ${judgeName} for typed quality and routing decisions…`)
          verdict = await run.judge(drafts, 'review')
          await run.report('review', byName(drafts), { verdict })
        }
        cost.reviewRounds = 1
      } else {
        // Judge the drafts first: a cross-review that would change nothing is a
        // whole round of agent calls, and the judge answers for the price of one call.
        stage(`Asking ${judgeName} for typed quality and routing decisions…`)
        verdict = await run.judge(drafts, 'draft')
        await run.report('draft', byName(drafts), { verdict })
      }
    }

    while (
      mode !== 'fast' &&
      cost.reviewRounds < maxReviewRounds &&
      verdict.needsAnotherPassProbability >= NEEDS_ANOTHER_PASS
    ) {
      if (reviewMode === 'debate' && debated === undefined) {
        debated = await debateReview(run, drafts)
        ;({ drafts, verdict } = debated)
        cost.reviewRounds += 1
        continue
      }
      if (debated) {
        // After a debate, a pass aims at what it left open, not at the whole verdict.
        const rulings = debated.verdict.disputes
        stage(`${judgeName} requested another pass on the open disagreements…`)
        drafts = await run.revise(
          drafts,
          disputeFeedback({
            disputes: debated.disputes,
            overflow: debated.overflow,
            verdict: rulings ? { ...verdict, disputes: rulings } : verdict,
            label: (name) => run.label(name),
          }),
          true,
        )
      } else {
        stage(
          cost.reviewRounds === 0
            ? crossReview(drafts.length)
            : `${judgeName} requested another cross-review pass…`,
        )
        drafts = await run.revise(drafts, JSON.stringify(verdict, null, 2))
      }
      cost.reviewRounds += 1
      stage(`Re-evaluating the revised plans with ${judgeName}…`)
      verdict = await run.judge(drafts, 'review')
      await run.report('review', byName(drafts), { verdict })
    }

    return synthesize(run, {
      drafts,
      verdict,
      ...(accepted ? { accepted } : {}),
      ...(debated ? { debated } : {}),
      ...(finalizerOverride ? { finalizerOverride } : {}),
    })
  }
}
