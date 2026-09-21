/** A provider id from the registry: `codex`, `claude`, `deepseek`, … */
export type AgentName = string

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
  model: string
}

/** One revised plan, for Jev: the agent that wrote it and the text. */
export interface JudgedPlan {
  agent: AgentName
  label: string
  plan: string
}

export interface JevJudge {
  judge(input: { task: string; plans: readonly JudgedPlan[]; model?: string }): Promise<JevVerdict>
}

export interface PlanOptions {
  task: string
  cwd: string
  timeoutMs: number
  maxReviewRounds?: 1 | 2
  jevModel?: string
  /** Override Jev's choice; must be the name of one of the planner's agents. */
  finalizer?: AgentName
  /**
   * Skip the placeholder check `plan` runs before any agent call. An empty
   * task is still passed through unchecked, as before the check existed.
   */
  allowAnyTask?: boolean
  /**
   * Skip the synthesis when Jev rates one revised plan stronger, and return
   * that plan as it is. Saves the last agent call at some cost in quality; on
   * a tie the finalizer still merges the plans. `false` by default.
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
   * each cross-review — and the final synthesis comes last.
   */
  onRound?: (round: PlanRound) => void | Promise<void>
}

/** One round of a run, as `PlanOptions.onRound` sees it. */
export interface PlanRound {
  /** 1 for the drafts, 2 and up for the cross-reviews; one more for the final plan. */
  round: number
  stage: 'draft' | 'review' | 'final'
  /** Each agent's plan in this round, by agent name; for `final`, the finalizer's merged plan. */
  plans: Record<AgentName, string>
  /** Jev's verdict on a `review` round's plans, and the one the final plan followed. */
  verdict?: JevVerdict
  /** How long the round took. */
  timings: RoundTimings
  /** On the `final` round: the plan is an agent's revised plan, chosen by `selectStronger`, not a merge. */
  selected?: true
}

/** How long one round of a run took, in milliseconds. */
export interface RoundTimings {
  /** The whole round: its agent calls, then Jev on a `review` round. */
  totalMs: number
  /** Each agent call in the round, by agent name. */
  agents: Record<AgentName, number>
  /** Jev judging a `review` round's plans. */
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
  /** The agent that merged the plan, or whose plan was selected. */
  finalizer: AgentName
  /** The plan is `finalizer`'s revised plan, chosen by `selectStronger`, not a merge. */
  selected?: true
  /** Each agent's last revised plan, by agent name. */
  drafts: Record<AgentName, string>
  timings: RunTimings
}
