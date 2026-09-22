import type { Verdict } from '../questions/questions.types.js'
import type { Dispute, RoundDebate } from '../debate/debate.types.js'
import type { AgentName, PlanningAgent } from '../provider/provider.types.js'

/**
 * A call after the draft: a cross-review or the synthesis. It takes the
 * review effort, and a shorter prompt for an agent continuing its session.
 * `undefined` for a draft.
 */
export type Later = { resumePrompt: string | undefined } | undefined

/** One agent's current plan. */
export interface Draft {
  agent: PlanningAgent
  plan: string
}

/** One agent's call in a round, and the plan that stands in if the round drops it. */
export interface RoundCall {
  agent: PlanningAgent
  prompt: string
  later: Later
  /** The plan kept if this agent is dropped; a draft round has none to fall back on. */
  fallback?: string
}

export type Generate = (
  agent: PlanningAgent,
  prompt: string,
  later: Later,
  signal?: AbortSignal,
) => Promise<string>

/** A draft the judge judged final on its own, in `fast` mode, and that verdict. */
export interface Accepted {
  draft: Draft
  verdict: Verdict
}

/** What a debate settled, kept for the passes and the merge after it. */
export interface DebateOutcome {
  drafts: Draft[]
  verdict: Verdict
  record: RoundDebate
  disputes: Dispute[]
  overflow: Dispute[]
}

/**
 * How much work a run spends before it answers.
 *
 * - `fast` answers with the first draft the judge rates 0.5 or more to stand alone,
 *   and stops the agents still drafting. That plan is one agent's, which no
 *   other agent has seen, and the quickest agent's draft is judged first, so it
 *   has the first chance. When the judge accepts no draft, the drafts are merged with
 *   no cross-review. It never cross-reviews.
 * - `balanced` lets the judge cut the run short: it judges the drafts first and orders a
 *   cross-review only when one would help, adopts a cross-reviewed plan that
 *   already stands alone instead of paying for a merge, and stops waiting on a
 *   straggling agent once the round has enough plans.
 * - `ultra` always runs the first cross-review, a second when the judge asks for it,
 *   and then merges, unless `selectStronger` keeps the reviewed plan the judge rates
 *   stronger: 2N + 1 agent calls in three sequential rounds, or 3N + 1 in four.
 */
export type PlanMode = 'fast' | 'balanced' | 'ultra'

/**
 * How the agents review each other once the judge orders a cross-review.
 *
 * - `standard` has each agent read every other plan and return a revised one.
 * - `debate` (experimental) turns the first cross-review into an argument: each
 *   agent lists its objections to every other plan, each author accepts or
 *   rejects the objections it received and revises its plan, and the judge rules on
 *   every objection an author rejected. A second pass, when the judge asks for one,
 *   is aimed at the disagreements the judge's rulings left open.
 */
export type ReviewMode = 'standard' | 'debate'

export interface PlanOptions {
  task: string
  cwd: string
  timeoutMs: number
  /**
   * `balanced` (the default) lets the judge skip work a run does not need; `ultra`
   * never skips; `fast` answers with the first draft the judge accepts. See `PlanMode`.
   */
  mode?: PlanMode
  /** Cross-review rounds a run may spend; `balanced` runs only the ones the judge asks for, `fast` none. */
  maxReviewRounds?: 0 | 1 | 2
  /** `standard` (the default) or `debate`; see `ReviewMode`. */
  reviewMode?: ReviewMode
  /**
   * In `debate` review, have an agent that reads the repository check each
   * disputed claim about it before the judge rules. Needs two or more such agents;
   * with fewer, the checks are skipped and the run says so. `false` by default.
   * Neither this nor `reviewMode: 'debate'` is allowed in `fast` mode, which has no review.
   */
  claimChecks?: boolean
  /**
   * How long a round waits for the agents still working once enough of them
   * have answered, in `balanced` and `fast` mode. `0` waits for every agent, as `ultra` always
   * does. A dropped agent's call is aborted, and a round never falls below two
   * plans, so nothing is dropped that the round still needs.
   */
  stragglerGraceMs?: number
  /** The model the judge should use, passed to it as `model`; what that names is up to the judge. */
  judgeModel?: string
  /**
   * Override the judge's choice; must be the name of one of the planner's agents.
   * In `fast` mode it only chooses who merges when the judge accepts no draft.
   */
  finalizer?: AgentName
  /**
   * Skip the placeholder check `plan` runs before any agent call. An empty
   * task is still passed through unchecked, as before the check existed.
   */
  allowAnyTask?: boolean
  /**
   * Skip the synthesis when the judge rates one cross-reviewed plan stronger, and
   * return that plan as it is, whatever `standsAloneProbability` says. Saves
   * the last agent call at some cost in quality. On a tie, or when no
   * cross-review ran, the finalizer still merges the plans. `false` by default.
   * Ignored in `fast` mode, which never cross-reviews.
   */
  selectStronger?: boolean
  /**
   * A reasoning effort for the cross-review and synthesis calls, by agent name:
   * lower effort where the job is editing a plan rather than exploring. An
   * agent not listed uses the effort it was created with in every stage.
   */
  reviewEfforts?: Readonly<Record<AgentName, string>>
  /**
   * Keep each agent's conversation from its draft to its later calls, so the
   * cross-review and synthesis continue with what it already read. `true` by
   * default; `false` starts every call afresh.
   */
  resume?: boolean
  onStage?: (message: string) => void
  /** Called with each agent's progress lines while it works, as `AgentRequest.onProgress` gets them. */
  onAgentProgress?: (agent: AgentName, line: string) => void
  /**
   * Called with every round's plans as soon as the round ends, and awaited:
   * a rejection stops the run. Rounds are numbered from 1 — the drafts, then
   * each cross-review — and the final plan comes last.
   */
  onRound?: (round: PlanRound) => void | Promise<void>
}

/** One round of a run, as `PlanOptions.onRound` sees it. */
export interface PlanRound {
  /** 1 for the drafts, 2 and up for the cross-reviews; one more for the final plan. */
  round: number
  /**
   * `draft`, `review` and `final` in every run. A `debate` review adds
   * `critique`, whose `plans` are the drafts unchanged, and then `review`; with
   * claim checks, `reply` (the revised plans, not yet judged) and `check` (the
   * same plans, judged) take the place of that `review`.
   */
  stage: 'draft' | 'critique' | 'reply' | 'check' | 'review' | 'final'
  /** Each agent's plan in this round, by agent name; for `final`, the plan the run answers with. */
  plans: Record<AgentName, string>
  /** In a `debate` review, each agent's raw answer in this round: its critique, reply or check. */
  artifacts?: Record<AgentName, string>
  /** In a `debate` review, what the round's answers said, parsed. */
  debate?: RoundDebate
  /** The judge's verdict on this round's plans, and the one the final plan followed. */
  verdict?: Verdict
  /** How long the round took. */
  timings: RoundTimings
  /**
   * On the `final` round: the plan is one agent's own, adopted whole rather
   * than merged. A `fast` run that accepts a draft still reports `draft`, then
   * `final`.
   */
  selected?: true
}

/** How long one round of a run took, in milliseconds. */
export interface RoundTimings {
  /** The whole round: its agent calls, then the judge when it judged the round. */
  totalMs: number
  /** Each agent call in the round that answered, by agent name; a dropped straggler has none. */
  agents: Record<AgentName, number>
  /** The judge's call on the round's plans; in `fast` mode, every solo judgement in the round, added up. */
  judgeMs?: number
}

/** How long a whole run took, in milliseconds. */
export interface RunTimings {
  totalMs: number
  /** One entry per round, in the order `onRound` receives them. */
  rounds: (RoundTimings & Pick<PlanRound, 'round' | 'stage'>)[]
}

export interface PlanResult {
  plan: string
  verdict: Verdict
  /** The agent that merged the plans, or whose plan was adopted whole. */
  finalizer: AgentName
  /**
   * The plan is `finalizer`'s own plan, adopted whole rather than merged: in
   * `balanced` mode when the judge judged it final as it stands, in `fast` mode when
   * the judge accepted it as it arrived, or by `selectStronger`.
   */
  selected?: true
  /** Each agent's last plan, by agent name; in `fast` mode, only the drafts that arrived. */
  drafts: Record<AgentName, string>
  /** The debate, in `debate` review once one ran: its objections, replies, disputes and checks. */
  debate?: RoundDebate
  timings: RunTimings
  /** What the run actually cost, for reporting and for tuning the next one. */
  cost: PlanCost
}

/** What a finished run spent, and where it stopped short. */
export interface PlanCost {
  mode: PlanMode
  reviewMode: ReviewMode
  /** Cross-review rounds run: `0` when the judge found the drafts ready as they were. */
  reviewRounds: number
  /** Whether a synthesis call merged the plans, or one plan was adopted whole. */
  synthesized: boolean
  /** Agent calls made, the synthesis included. */
  agentCalls: number
  /** The judge evaluations made: one per judged round, and in `fast` mode one per draft judged alone. */
  judgeCalls: number
  /**
   * Agents a round stopped waiting for, in the order they were dropped; in
   * `fast` mode, also the agents stopped once a draft was accepted.
   */
  dropped: AgentName[]
}
