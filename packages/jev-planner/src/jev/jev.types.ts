import type { ChoiceResponse, NoulResponse, ScoreResponse } from '@typesafe-ai/sdk'
import type { DisputeKey, DisputeRuling } from '@rxova/planner-core'

/** Jev's answers, keyed as `planQuestions` keys the questions. */
export type Answers = {
  readonly stronger_plan: ChoiceResponse
  readonly finalizer: ChoiceResponse
  readonly completeness: ScoreResponse
  readonly feasibility: ScoreResponse
  readonly risk_coverage: ScoreResponse
  readonly needs_another_pass: NoulResponse
  readonly stands_alone: NoulResponse
} & Partial<Record<DisputeKey, ChoiceResponse<Record<DisputeRuling['choice'], string>>>>
