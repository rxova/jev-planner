/** A provider id from the registry: `codex`, `claude`, `deepseek`, … */
export type AgentName = string

export interface AgentRequest {
  prompt: string
  cwd: string
  timeoutMs: number
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
  onStage?: (message: string) => void
}

export interface PlanResult {
  plan: string
  verdict: JevVerdict
  finalizer: AgentName
  /** Each agent's last revised plan, by agent name. */
  drafts: Record<AgentName, string>
}
