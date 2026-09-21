export type AgentName = 'codex' | 'claude'

export interface AgentRequest {
  prompt: string
  cwd: string
  timeoutMs: number
}

export interface PlanningAgent {
  readonly name: AgentName
  generate(request: AgentRequest): Promise<string>
}

export interface JevVerdict {
  strongerPlan: 'codex' | 'claude' | 'tie'
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

export interface JevJudge {
  judge(input: {
    task: string
    codexPlan: string
    claudePlan: string
    model?: string
  }): Promise<JevVerdict>
}

export interface PlanOptions {
  task: string
  cwd: string
  timeoutMs: number
  maxReviewRounds?: 1 | 2
  jevModel?: string
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
  drafts: {
    codex: string
    claude: string
  }
}
