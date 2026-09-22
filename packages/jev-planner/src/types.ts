/** A provider id from the registry: `codex`, `claude`, `deepseek`, … */
export type AgentName = string

/**
 * How much work a run spends before it answers.
 *
 * - `fast` lets Jev cut the run short: it judges the drafts first and orders a
 *   cross-review only when one would help, adopts a cross-reviewed plan that
 *   already stands alone instead of paying for a merge, and stops waiting on a
 *   straggling agent once the round has enough plans.
 * - `ultra` always cross-reviews and always merges: the most material for the
 *   money, at 2N + 1 agent calls and three sequential rounds.
 */
export type PlanMode = 'fast' | 'ultra'

export interface AgentRequest {
  prompt: string
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
   * How likely the strongest plan is already a final plan on its own. In `fast`
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
  /** `fast` (the default) lets Jev skip work a run does not need; `ultra` never skips. */
  mode?: PlanMode
  /** Cross-review rounds a run may spend; `fast` runs only the ones Jev asks for. */
  maxReviewRounds?: 0 | 1 | 2
  /**
   * How long a round waits for the agents still working once enough of them
   * have answered, in `fast` mode. `0` waits for every agent, as `ultra` always
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
}

export interface PlanResult {
  plan: string
  verdict: JevVerdict
  /** The agent that merged the plans, or whose plan was adopted whole. */
  finalizer: AgentName
  /** Each agent's last plan, by agent name. */
  drafts: Record<AgentName, string>
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
