import { choice, noul, score, TypeSafeClient } from '@typesafe-ai/sdk'
import type {
  ChoiceResponse,
  NoulResponse,
  Question,
  ScoreCriteria,
  ScoreResponse,
} from '@typesafe-ai/sdk'
import { disputeKey, judgedPlans, planQuestions, STAGE_TEXT } from '@rxova/planner-core'
import type {
  Dispute,
  DisputeKey,
  DisputeRuling,
  JudgedPlan,
  JudgeStage,
  PlanJudge,
  PlanQuestion,
  Verdict,
} from '@rxova/planner-core'

/** A neutral question as the SDK asks it. */
function toTypeSafe(question: PlanQuestion): Question {
  if (question.kind === 'choice') {
    const instructions = question.details
      ? { question: question.ask, ...question.details }
      : question.ask
    return choice(instructions, question.options)
  }
  if (question.kind === 'score') {
    // A rubric has at least two levels; the SDK's tuple type says so.
    return score(question.ask, question.levels as unknown as ScoreCriteria)
  }
  return noul(question.ask, { true: question.yes, false: question.no })
}

/** Jev's answers, keyed as `planQuestions` keys the questions. */
type Answers = {
  readonly stronger_plan: ChoiceResponse
  readonly finalizer: ChoiceResponse
  readonly completeness: ScoreResponse
  readonly feasibility: ScoreResponse
  readonly risk_coverage: ScoreResponse
  readonly needs_another_pass: NoulResponse
  readonly stands_alone: NoulResponse
} & Partial<Record<DisputeKey, ChoiceResponse<Record<DisputeRuling['choice'], string>>>>

/** TypeSafe Jev, asked the planner's questions in one `systemOne` call per judged round. */
export class TypeSafeJevJudge implements PlanJudge {
  readonly name = 'Jev'

  constructor(private readonly client: TypeSafeClient = new TypeSafeClient()) {}

  async judge(input: {
    task: string
    plans: readonly JudgedPlan[]
    stage: JudgeStage
    disputes?: readonly Dispute[]
    model?: string
  }): Promise<Verdict> {
    const disputes = input.disputes ?? []
    const questions = planQuestions({ plans: input.plans, stage: input.stage, disputes })
    const response = await this.client.systemOne({
      ...(input.model ? { model: input.model } : {}),
      state: {
        task: input.task,
        stage: STAGE_TEXT[input.stage],
        plans: judgedPlans(input.plans),
      },
      questions: Object.fromEntries(
        Object.entries(questions).map(([key, question]) => [key, toTypeSafe(question)]),
      ),
    })

    // The questions are built at run time, so the SDK cannot infer the answers; the keys are ours.
    const answers = response.answers as unknown as Answers
    return {
      strongerPlan: answers.stronger_plan.choice,
      strongerPlanConfidence: answers.stronger_plan.confidence,
      finalizer: answers.finalizer.choice,
      finalizerConfidence: answers.finalizer.confidence,
      completeness: answers.completeness.score,
      completenessConfidence: answers.completeness.confidence,
      feasibility: answers.feasibility.score,
      feasibilityConfidence: answers.feasibility.confidence,
      riskCoverage: answers.risk_coverage.score,
      riskCoverageConfidence: answers.risk_coverage.confidence,
      needsAnotherPassProbability: answers.needs_another_pass.noul,
      standsAloneProbability: answers.stands_alone.noul,
      ...(disputes.length > 0
        ? {
            disputes: disputes.map((dispute, index): DisputeRuling => {
              const answer = answers[disputeKey(index)]
              return answer
                ? { id: dispute.id, choice: answer.choice, confidence: answer.confidence }
                : { id: dispute.id, choice: 'unclear', confidence: 0 }
            }),
          }
        : {}),
      model: response.model,
    }
  }
}
