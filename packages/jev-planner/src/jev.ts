import { choice, noul, score, TypeSafeClient } from '@typesafe-ai/sdk'
import type { ChoiceResponse } from '@typesafe-ai/sdk'
import type {
  AgentName,
  Dispute,
  DisputeRuling,
  JevJudge,
  JevVerdict,
  JudgedPlan,
} from './types.js'

const MAX_PLAN_CHARS = 40_000

function bounded(text: string): string {
  if (text.length <= MAX_PLAN_CHARS) return text
  return `${text.slice(0, MAX_PLAN_CHARS)}\n[truncated for Jev evaluation]`
}

function agentOptions(plans: readonly JudgedPlan[], describe: (label: string) => string) {
  return Object.fromEntries(plans.map(({ agent, label }) => [agent, describe(label)]))
}

function labelOf(plans: readonly JudgedPlan[], agent: AgentName): string {
  return plans.find((plan) => plan.agent === agent)?.label ?? agent
}

/**
 * One choice per dispute: does the objection hold, does the author's
 * rejection, or does the material not settle it. Keyed `dispute_<n>`, in the
 * order of `disputes`, so the answers map back by position.
 */
type DisputeKey = `dispute_${number}`
const disputeKey = (index: number) => `dispute_${String(index + 1)}` as DisputeKey

function disputeQuestions(plans: readonly JudgedPlan[], disputes: readonly Dispute[]) {
  const questions: Record<DisputeKey, ReturnType<typeof disputeQuestion>> = {}
  disputes.forEach((dispute, index) => {
    questions[disputeKey(index)] = disputeQuestion(plans, dispute)
  })
  return questions
}

function disputeQuestion(plans: readonly JudgedPlan[], dispute: Dispute) {
  const critics = dispute.critics.map((critic) => labelOf(plans, critic)).join(' and ')
  const author = labelOf(plans, dispute.target)
  return choice(
    {
      question: `${critics} objected to ${author}'s plan, and ${author} rejected the objection. Judging from the plans, which side is right?`,
      claim: dispute.claim,
      why: dispute.reasons,
      rejection: dispute.rejections,
      check: dispute.check
        ? `${dispute.check.result.toUpperCase()}${dispute.check.evidence ? `: ${dispute.check.evidence}` : ''}`
        : 'not checked',
    },
    {
      critic: `${critics}'s objection holds`,
      author: `${author}'s position holds`,
      unclear: 'The material does not settle it',
    },
  )
}

type Stage = 'solo' | 'draft' | 'review'

/** What Jev is told the plans are. */
const STAGE_TEXT: Record<Stage, string> = {
  solo: "One agent's independent draft, judged alone: no other agent has seen it",
  draft: 'Independent drafts: no agent has seen another agent’s plan yet',
  review: 'Cross-reviewed plans: each agent has read every other plan and revised its own',
}

/** Whether the plan could be the final plan: of the strongest plan, or of a lone draft. */
function standsAlone(stage: Stage) {
  return stage === 'solo'
    ? noul(
        'Could this plan, as it stands, be handed to an implementer as the final plan, with no review or merge?',
        {
          true: 'The plan is complete and self-contained; ready to implement',
          false: 'The plan has gaps that review or another plan would need to fill',
        },
      )
    : noul(
        'Could the strongest plan be handed to an implementer as the final plan, with no merge of the others?',
        {
          true: 'One plan is already complete and self-contained; merging would add nothing material',
          false: 'The plans hold complementary material that a final merge has to combine',
        },
      )
}

export class TypeSafeJevJudge implements JevJudge {
  constructor(private readonly client: TypeSafeClient = new TypeSafeClient()) {}

  async judge(input: {
    task: string
    plans: readonly JudgedPlan[]
    stage: Stage
    disputes?: readonly Dispute[]
    model?: string
  }): Promise<JevVerdict> {
    const disputes = input.disputes ?? []
    const response = await this.client.systemOne({
      ...(input.model ? { model: input.model } : {}),
      state: {
        task: input.task,
        stage: STAGE_TEXT[input.stage],
        // Keyed by agent name: the names the choices below answer with.
        plans: Object.fromEntries(
          input.plans.map(({ agent, label, plan }) => [
            agent,
            { author: label, plan: bounded(plan) },
          ]),
        ),
      },
      questions: {
        stronger_plan: choice(
          'Which plan is most likely to lead to a correct, efficient implementation of the task?',
          {
            ...agentOptions(
              input.plans,
              (label) => `${label}'s plan is materially stronger overall`,
            ),
            tie: 'No plan is materially stronger, or their strengths are complementary',
          },
        ),
        finalizer: choice(
          "Which agent's plan demonstrates the best judgment for merging all the plans into the final plan?",
          agentOptions(input.plans, (label) => `${label} should perform the final synthesis`),
        ),
        completeness: score(
          'How complete is the combined planning material for the requested task?',
          [
            'Major requirements or repository impacts are missing',
            'Several important details are missing',
            'Mostly complete, with minor gaps',
            'Complete and implementation-ready',
          ],
        ),
        feasibility: score(
          'How feasible and repository-grounded are the proposed implementation steps?',
          [
            'Mostly speculative or incompatible with the repository',
            'Partly grounded but contains risky assumptions',
            'Mostly grounded and feasible',
            'Highly concrete, minimal, and feasible',
          ],
        ),
        risk_coverage: score('How well do the plans cover edge cases, tests, and rollout risks?', [
          'Risks are largely absent',
          'Only obvious risks are covered',
          'Important risks and tests are covered',
          'Risk, testing, and rollout coverage is thorough',
        ]),
        needs_another_pass: noul(
          'Would a cross-review round, each agent revising its plan against all the others, materially improve the final implementation plan?',
          {
            true: 'Important contradictions, omissions, or unsupported assumptions remain',
            false: 'The material is ready for final synthesis',
          },
        ),
        stands_alone: standsAlone(input.stage),
        ...disputeQuestions(input.plans, disputes),
      },
    })

    const answers = response.answers
    // The spread above widens to an index the SDK's inference drops; the keys are ours.
    const rulings = answers as unknown as Partial<
      Record<DisputeKey, ChoiceResponse<ReturnType<typeof disputeQuestion>['criteria']>>
    >
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
              const answer = rulings[disputeKey(index)]
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
