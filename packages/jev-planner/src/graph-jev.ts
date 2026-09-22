import { createJudge } from '@rxova/journey-judge'
import type { Answer, JudgeModel, Question, Rule } from '@rxova/journey-judge'
import { disputeKey, jevQuestions, judgedPlans, labelOf, STAGE_TEXT } from './jev-questions.js'
import type { DisputeKey, JevQuestion, JevQuestions } from './jev-questions.js'
import { jevRules, jevSkips } from './jev-rules.js'
import type { JevState } from './jev-rules.js'
import type { Dispute, DisputeRuling, JevJudge, JevVerdict } from './types.js'

export interface GraphJevOptions {
  /** At least one model. Samples go to the models in turn. */
  panel: readonly JudgeModel[]
  /** Samples per question round; the judge's default otherwise. */
  samples?: number
  /** Model calls one verdict may make, retries and repairs included. */
  maxCalls?: number
  /** Budget for one model call, in milliseconds. */
  timeoutMs?: number
  /** Let a claim check settle its dispute without the panel. Off by default. */
  claimChecks?: boolean
}

type JudgeInput = Parameters<JevJudge['judge']>[0]

/**
 * The answers, keyed as `jevQuestions` keys the questions. With one plan,
 * `stronger_plan` and `finalizer` are not asked, and not read.
 */
type Answers = {
  readonly [K in keyof JevQuestions]: Answer<JevQuestions[K]>
}

/** The state the panel reads: the plans, and each dispute under its question's key. */
function stateOf(input: JudgeInput, disputes: readonly Dispute[]): JevState {
  return {
    task: input.task,
    stage: STAGE_TEXT[input.stage],
    plans: judgedPlans(input.plans),
    ...(disputes.length > 0
      ? {
          disputes: Object.fromEntries(
            disputes.map((dispute, index) => [
              disputeKey(index),
              {
                critics: dispute.critics
                  .map((critic) => labelOf(input.plans, critic))
                  .join(' and '),
                author: labelOf(input.plans, dispute.target),
                claim: dispute.claim,
                why: dispute.reasons,
                rejection: dispute.rejections,
                check: dispute.check ?? null,
              },
            ]),
          ),
        }
      : {}),
  }
}

/** A question as the judge asks it: a dispute's details are in the state, under its key. */
function toJudge(key: string, question: JevQuestion): Question {
  if (question.kind !== 'choice' || !question.details) return question
  return {
    kind: 'choice',
    ask: `${question.ask} The dispute is \`disputes.${key}\` in the state.`,
    options: question.options,
    fallback: question.fallback,
  }
}

/**
 * Jev as a graph: rules settle what they can, a panel of models samples the
 * rest, and questions whose answer cannot change the run take their fallback
 * without a call. Built on `@rxova/journey-judge`; each verdict carries the
 * judge's `trail`. The `model` input is ignored: the panel names its models.
 */
export class GraphJevJudge implements JevJudge {
  private readonly engine: ReturnType<typeof createJudge>
  private readonly claimChecks: boolean
  private readonly panelIds: string

  constructor(options: GraphJevOptions) {
    this.engine = createJudge({
      panel: options.panel,
      ...(options.samples === undefined ? {} : { samples: options.samples }),
      ...(options.maxCalls === undefined ? {} : { maxCalls: options.maxCalls }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    })
    this.claimChecks = options.claimChecks ?? false
    this.panelIds = options.panel.map((model) => model.id).join('+')
  }

  async judge(input: JudgeInput): Promise<JevVerdict> {
    const disputes = input.disputes ?? []
    const all = jevQuestions({ plans: input.plans, stage: input.stage, disputes })
    // One plan leaves a choice of one: the judge needs two options, and the answer is known.
    const sole = input.plans.length === 1 ? input.plans[0] : undefined
    const questions: Record<string, Question> = {}
    for (const [key, question] of Object.entries(all) as [string, JevQuestion][]) {
      if (sole !== undefined && (key === 'stronger_plan' || key === 'finalizer')) continue
      questions[key] = toJudge(key, question)
    }
    const keys = disputes.map((_, index) => disputeKey(index))
    const rules = jevRules(keys, { claimChecks: this.claimChecks }) as Readonly<
      Record<string, readonly Rule<Question, JevState>[]>
    >
    const skip = jevSkips(input.stage, input.progress).filter((key) => key in questions)

    const judgement = await this.engine.ask({
      state: stateOf(input, disputes),
      questions,
      rules,
      skip,
    })
    const answers = judgement.answers as Answers

    const settled: string[] = sole === undefined ? [] : ['stronger_plan', 'finalizer']
    const abstained: string[] = []
    for (const [key, entry] of Object.entries(judgement.trail.answers)) {
      if (entry.source === 'rule') settled.push(key)
      else if (entry.source === 'abstained') abstained.push(key)
    }

    const { stronger_plan: stronger, finalizer } = answers
    const choices = sole
      ? {
          strongerPlan: sole.agent,
          strongerPlanConfidence: 1,
          finalizer: sole.agent,
          finalizerConfidence: 1,
        }
      : {
          strongerPlan: stronger.choice,
          strongerPlanConfidence: stronger.confidence,
          // A split vote is `tie`, which is no agent: the finalizer takes its fallback, an agent.
          finalizer: finalizer.choice === 'tie' ? all.finalizer.fallback : finalizer.choice,
          finalizerConfidence: finalizer.confidence,
        }
    const { completeness, feasibility, risk_coverage: riskCoverage } = answers

    return {
      ...choices,
      completeness: completeness.score,
      completenessConfidence: completeness.confidence,
      feasibility: feasibility.score,
      feasibilityConfidence: feasibility.confidence,
      riskCoverage: riskCoverage.score,
      riskCoverageConfidence: riskCoverage.confidence,
      needsAnotherPassProbability: answers.needs_another_pass.probability,
      standsAloneProbability: answers.stands_alone.probability,
      ...(disputes.length > 0
        ? {
            disputes: disputes.map((dispute, index): DisputeRuling => {
              // Every dispute is asked, so the judge answered it. A split vote is
              // `tie`, which rules for neither side.
              const { choice, confidence } = answers[disputeKey(index)] as Pick<
                Answer<JevQuestions[DisputeKey]>,
                'choice' | 'confidence'
              >
              return {
                id: dispute.id,
                choice: choice === 'critic' || choice === 'author' ? choice : 'unclear',
                confidence,
              }
            }),
          }
        : {}),
      model: [
        this.panelIds,
        ...(settled.length > 0 ? [`rule:${settled.join(',')}`] : []),
        ...(abstained.length > 0 ? [`abstained:${abstained.join(',')}`] : []),
      ].join(' '),
      trail: judgement.trail,
    }
  }
}
