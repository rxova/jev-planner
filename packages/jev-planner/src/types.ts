/** A provider id from the registry: `codex`, `claude`, `deepseek`, … */
export type AgentName = string

/**
 * How much work a run spends before it answers.
 *
 * - `balanced` lets Jev cut the run short: it judges the drafts first and orders a
 *   cross-review only when one would help, adopts a cross-reviewed plan that
 *   already stands alone instead of paying for a merge, and stops waiting on a
 *   straggling agent once the round has enough plans.
 * - `ultra` always cross-reviews and always merges: the most material for the
 *   money, at 2N + 1 agent calls and three sequential rounds.
 */
export type PlanMode = 'balanced' | 'ultra'

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
    /** Whether these are the independent drafts or plans that have been cross-reviewed. */
    stage: 'draft' | 'review'
    model?: string
  }): Promise<JevVerdict>
}

export interface PlanOptions {
  task: string
  cwd: string
  timeoutMs: number
  /** `balanced` (the default) lets Jev skip work a run does not need; `ultra` never skips. */
  mode?: PlanMode
  /** Cross-review rounds a run may spend; `balanced` runs only the ones Jev asks for. */
  maxReviewRounds?: 0 | 1 | 2
  /**
   * How long a round waits for the agents still working once enough of them
   * have answered, in `balanced` mode. `0` waits for every agent, as `ultra` always
   * does. A dropped agent's call is aborted, and a round never falls below two
   * plans, so nothing is dropped that the round still needs.
   */
  stragglerGraceMs?: number
  jevModel?: string
  /** Override Jev's choice; must be the name of one of the planner's agents. */
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
  stage: 'draft' | 'review' | 'final'
  /** Each agent's plan in this round, by agent name; for `final`, the plan the run answers with. */
  plans: Record<AgentName, string>
  /** Jev's verdict on this round's plans, and the one the final plan followed. */
  verdict?: JevVerdict
  /** How long the round took. */
  timings: RoundTimings
  /** On the `final` round: the plan is one agent's own, adopted whole rather than merged. */
  selected?: true
}

/** How long one round of a run took, in milliseconds. */
export interface RoundTimings {
  /** The whole round: its agent calls, then Jev when it judged the round. */
  totalMs: number
  /** Each agent call in the round that answered, by agent name; a dropped straggler has none. */
  agents: Record<AgentName, number>
  /** Jev judging the round's plans. */
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
   * `balanced` mode when Jev judged it final as it stands, or by `selectStronger`.
   */
  selected?: true
  /** Each agent's last plan, by agent name. */
  drafts: Record<AgentName, string>
  timings: RunTimings
  /** What the run actually cost, for reporting and for tuning the next one. */
  cost: PlanCost
}

/** What a finished run spent, and where it stopped short. */
export interface PlanCost {
  mode: PlanMode
  /** Cross-review rounds run: `0` when Jev found the drafts ready as they were. */
  reviewRounds: number
  /** Whether a synthesis call merged the plans, or one plan was adopted whole. */
  synthesized: boolean
  /** Agent calls made, the synthesis included. */
  agentCalls: number
  /** Jev evaluations made: one per judged round. */
  jevCalls: number
  /** Agents a round stopped waiting for, in the order they were dropped. */
  dropped: AgentName[]
}
