import type { AgentName } from '../provider/provider.types.js'
import type { Dispute, DisputeRuling } from '../debate/debate.types.js'

export type JudgeStage = 'solo' | 'draft' | 'review'

type Details = Readonly<Record<string, string | readonly string[]>>

/**
 * One question for a judge, whatever answers it: TypeSafe's Jev or a panel of
 * models. Each kind declares the `fallback` a judge takes when it cannot answer.
 */
export type PlanQuestion =
  | {
      readonly kind: 'choice'
      readonly ask: string
      /** What the question is about, beside the question itself. */
      readonly details?: Details
      /** Option key to what the option is. */
      readonly options: Readonly<Record<string, string>>
      /** An option key, or `'tie'`. */
      readonly fallback: string
    }
  | {
      readonly kind: 'score'
      readonly ask: string
      /** What each level means, lowest first. */
      readonly levels: readonly string[]
      readonly fallback: number
    }
  | {
      readonly kind: 'binary'
      readonly ask: string
      readonly yes: string
      readonly no: string
      /** A probability of yes. */
      readonly fallback: number
    }

/** One choice per dispute, keyed `dispute_<n>` in the order of the disputes. */
export type DisputeKey = `dispute_${number}`

/** Each verdict field's question, keyed by the name a judge answers under. */
export type PlanQuestions = {
  readonly stronger_plan: PlanQuestion & { readonly kind: 'choice' }
  readonly finalizer: PlanQuestion & { readonly kind: 'choice' }
  readonly completeness: PlanQuestion & { readonly kind: 'score' }
  readonly feasibility: PlanQuestion & { readonly kind: 'score' }
  readonly risk_coverage: PlanQuestion & { readonly kind: 'score' }
  readonly needs_another_pass: PlanQuestion & { readonly kind: 'binary' }
  readonly stands_alone: PlanQuestion & { readonly kind: 'binary' }
} & Readonly<Record<DisputeKey, PlanQuestion & { readonly kind: 'choice' }>>

/** The judge's answer on one set of plans. Every confidence and probability is from 0 to 1, every score from 0 to 3. */
export interface Verdict {
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
  /** The judge's ruling on each dispute it was given, in `debate` review; absent when it was given none. */
  disputes?: DisputeRuling[]
  model: string
}

/** One plan, for the judge: the agent that wrote it and the text. */
export interface JudgedPlan {
  agent: AgentName
  label: string
  plan: string
}

/**
 * What rates a run's plans and routes it: which plan is stronger, who merges,
 * whether another pass would help, and the rulings on a debate's disputes.
 * The planner never calls a model for this itself; `TypeSafeJevJudge` in
 * `jev-planner` is one judge.
 */
export interface PlanJudge {
  /** How the run's stage messages refer to the judge: `Jev`. */
  readonly name: string
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
    /** `PlanOptions.judgeModel`, when the run set one. */
    model?: string
  }): Promise<Verdict>
}
