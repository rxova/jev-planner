/** A provider id from the registry: `codex`, `claude`, `deepseek`, … */
export type AgentName = string

/**
 * How much work a run spends before it answers.
 *
 * - `fast` answers with the first draft Jev judges good enough on its own, and
 *   stops the agents still drafting. That plan is one agent's, which no other
 *   agent has seen, and the quickest agent's draft is judged first, so it wins
 *   most runs. When Jev accepts no draft, the drafts are merged with no
 *   cross-review. It never cross-reviews.
 * - `balanced` lets Jev cut the run short: it judges the drafts first and orders a
 *   cross-review only when one would help, adopts a cross-reviewed plan that
 *   already stands alone instead of paying for a merge, and stops waiting on a
 *   straggling agent once the round has enough plans.
 * - `ultra` always cross-reviews and always merges: the most material for the
 *   money, at 2N + 1 agent calls and three sequential rounds.
 */
export type PlanMode = 'fast' | 'balanced' | 'ultra'

/**
 * How the agents review each other once Jev orders a cross-review.
 *
 * - `standard` has each agent read every other plan and return a revised one.
 * - `debate` (experimental) turns the first cross-review into an argument: each
 *   agent lists its objections to every other plan, each author accepts or
 *   rejects the objections it received and revises its plan, and Jev rules on
 *   every objection an author rejected. A second pass, when Jev asks for one,
 *   is aimed at the disagreements Jev's rulings left open.
 */
export type ReviewMode = 'standard' | 'debate'

/** One objection a critic raised against another agent's plan, in `debate` review. */
export interface Objection {
  /** `<critic>:<target>:C<n>`, unique in a run: what the author's reply answers. */
  id: string
  critic: AgentName
  /** The agent whose plan the objection is about. */
  target: AgentName
  claim: string
  /** The critic's reason, or `''` when it gave none. */
  why: string
  /** Whether the claim is about a file, symbol or export in the repository, and so can be checked. */
  repo: boolean
}

/** An author's answer to one objection against its plan. */
export interface Reply {
  /** The `Objection.id` it answers. */
  id: string
  author: AgentName
  decision: 'accept' | 'reject'
  reason: string
}

/** What an agent that reads the repository found when it checked a disputed claim. */
export interface ClaimCheck {
  checker: AgentName
  /** `unknown` also stands for an answer that could not be parsed, or a checker that was dropped. */
  result: 'confirm' | 'refute' | 'unknown'
  /** Where the checker looked, such as `src/jev.ts:agentOptions`; `''` when it said nothing. */
  evidence: string
}

/**
 * An objection its author rejected, for Jev to rule on. The same claim from
 * several critics against the same plan is one dispute.
 */
export interface Dispute {
  /** `D1`, `D2`, …, in the order the disputes are ranked. */
  id: string
  /** The author, whose plan the claim is about. */
  target: AgentName
  /** Every critic who raised it, in the order they raised it. */
  critics: AgentName[]
  /** The ids of the objections it merges. */
  objections: string[]
  claim: string
  /** The critics' reasons, those that gave one. */
  reasons: string[]
  /** The author's reasons for rejecting it. */
  rejections: string[]
  repo: boolean
  /** Present once a claim check ran on it. */
  check?: ClaimCheck
}

/** Jev's ruling on one dispute. */
export interface DisputeRuling {
  /** The `Dispute.id` it rules on. */
  id: string
  /** Whose position holds; `unclear` when the material does not settle it. */
  choice: 'critic' | 'author' | 'unclear'
  confidence: number
}

/** The debate behind a round, in `debate` review; see `PlanRound.debate`. */
export interface RoundDebate {
  /** Every objection the critics raised, as parsed. */
  objections: Objection[]
  /** Every reply the authors gave that answers an objection, first reply per objection. */
  replies?: Reply[]
  /** The ids of objections that got no parseable reply, including those to a dropped author. */
  unanswered?: string[]
  /** The rejected objections Jev rules on: at most eight, ranked. */
  disputes?: Dispute[]
  /** Rejected objections past the cap, which Jev did not rule on. */
  overflow?: Dispute[]
  /** Whether claim checks ran, when they were asked for. */
  claimChecks?: 'ran' | 'skipped'
}

/**
 * One agent's conversation, carried from one stage of a run to the next. The
 * planner creates one per agent per run and passes it on every call to that
 * agent; the provider fills it in on the first call and continues from it on
 * the next ones. An agent that ignores it starts every call afresh.
 */
export interface AgentSession {
  /** The conversation to continue, once a call has started one: a CLI's session or thread id. */
  id?: string
}

export interface AgentRequest {
  /** The whole prompt, for an agent that starts afresh. */
  prompt: string
  /**
   * The same request for an agent continuing `session`, which already holds
   * the task and its own earlier plans: `prompt` without them. `prompt` is used
   * when this is absent or the conversation cannot be continued.
   */
  resumePrompt?: string
  /** Continue this conversation, when the agent can; see `AgentSession`. */
  session?: AgentSession
  /**
   * A reasoning effort for this call only, over the one the agent was created
   * with. An agent that takes no effort ignores it.
   */
  effort?: string
  cwd: string
  timeoutMs: number
  /** Called with a line about the agent's work as it happens: a message, a command, a file read. */
  onProgress?: (line: string) => void
  /** Aborted when the run no longer needs this answer, so the agent stops working and stops billing. */
  signal?: AbortSignal
}

export interface PlanningAgent {
  /** The provider id: what `--agents`, `--finalizer` and the Jev verdict use. */
  readonly name: AgentName
  /** How prompts, stages and the plan refer to it: `Codex`, `DeepSeek`, … */
  readonly label: string
  /**
   * Whether the agent opens files in the repository itself, as an agent CLI
   * does. Only such agents check disputed claims in `debate` review; an agent
   * that leaves this out is treated as one that does not.
   */
  readonly readsRepository?: boolean
  generate(request: AgentRequest): Promise<string>
}

export interface JevVerdict {
  /** An agent's name, or `'tie'`. */
  strongerPlan: string
  strongerPlanConfidence: number
  finalizer: AgentName
  finalizerConfidence: number
  completeness: number
  completenessConfidence: number
  feasibility: number
  feasibilityConfidence: number
  riskCoverage: number
  riskCoverageConfidence: number
  needsAnotherPassProbability: number
  /**
   * How likely the strongest plan is already a final plan on its own. In `balanced`
   * mode a cross-reviewed run above the threshold is answered with that plan
   * rather than a synthesis call.
   */
  standsAloneProbability: number
  /** Jev's ruling on each dispute it was given, in `debate` review; absent when it was given none. */
  disputes?: DisputeRuling[]
  model: string
}

/** One plan, for Jev: the agent that wrote it and the text. */
export interface JudgedPlan {
  agent: AgentName
  label: string
  plan: string
}

export interface JevJudge {
  judge(input: {
    task: string
    plans: readonly JudgedPlan[]
    /**
     * `draft` for the independent drafts, `review` for plans that have been
     * cross-reviewed, and `solo` for one draft judged alone in `fast` mode.
     * A `solo` verdict's `strongerPlan` and `finalizer` can only name that
     * agent or `tie`, and the planner ignores both.
     */
    stage: 'solo' | 'draft' | 'review'
    /** In `debate` review, the rejected objections to rule on alongside the plans. */
    disputes?: readonly Dispute[]
    model?: string
  }): Promise<JevVerdict>
}

export interface PlanOptions {
  task: string
  cwd: string
  timeoutMs: number
  /**
   * `balanced` (the default) lets Jev skip work a run does not need; `ultra`
   * never skips; `fast` answers with the first draft Jev accepts. See `PlanMode`.
   */
  mode?: PlanMode
  /** Cross-review rounds a run may spend; `balanced` runs only the ones Jev asks for, `fast` none. */
  maxReviewRounds?: 0 | 1 | 2
  /** `standard` (the default) or `debate`; see `ReviewMode`. */
  reviewMode?: ReviewMode
  /**
   * In `debate` review, have an agent that reads the repository check each
   * disputed claim about it before Jev rules. Needs two or more such agents;
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
  jevModel?: string
  /**
   * Override Jev's choice; must be the name of one of the planner's agents.
   * In `fast` mode it only chooses who merges when Jev accepts no draft.
   */
  finalizer?: AgentName
  /**
   * Skip the placeholder check `plan` runs before any agent call. An empty
   * task is still passed through unchecked, as before the check existed.
   */
  allowAnyTask?: boolean
  /**
   * Skip the synthesis when Jev rates one cross-reviewed plan stronger, and
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
  /** Jev's verdict on this round's plans, and the one the final plan followed. */
  verdict?: JevVerdict
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
  /** The whole round: its agent calls, then Jev when it judged the round. */
  totalMs: number
  /** Each agent call in the round that answered, by agent name; a dropped straggler has none. */
  agents: Record<AgentName, number>
  /** Jev judging the round's plans; in `fast` mode, every solo judgement in the round, added up. */
  jevMs?: number
}

/** How long a whole run took, in milliseconds. */
export interface RunTimings {
  totalMs: number
  /** One entry per round, in the order `onRound` receives them. */
  rounds: (RoundTimings & Pick<PlanRound, 'round' | 'stage'>)[]
}

export interface PlanResult {
  plan: string
  verdict: JevVerdict
  /** The agent that merged the plans, or whose plan was adopted whole. */
  finalizer: AgentName
  /**
   * The plan is `finalizer`'s own plan, adopted whole rather than merged: in
   * `balanced` mode when Jev judged it final as it stands, in `fast` mode when
   * Jev accepted it as it arrived, or by `selectStronger`.
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
  /** Cross-review rounds run: `0` when Jev found the drafts ready as they were. */
  reviewRounds: number
  /** Whether a synthesis call merged the plans, or one plan was adopted whole. */
  synthesized: boolean
  /** Agent calls made, the synthesis included. */
  agentCalls: number
  /** Jev evaluations made: one per judged round, and in `fast` mode one per draft judged alone. */
  jevCalls: number
  /**
   * Agents a round stopped waiting for, in the order they were dropped; in
   * `fast` mode, also the agents stopped once a draft was accepted.
   */
  dropped: AgentName[]
}
