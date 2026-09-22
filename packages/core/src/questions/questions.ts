import type { AgentName } from '../provider/provider.types.js'
import type { Dispute } from '../debate/debate.types.js'
import type {
  DisputeKey,
  JudgeStage,
  JudgedPlan,
  PlanQuestion,
  PlanQuestions,
} from './questions.types.js'

const MAX_PLAN_CHARS = 40_000

/** A plan cut to what a judge is shown. */
export function bounded(text: string): string {
  if (text.length <= MAX_PLAN_CHARS) return text
  return `${text.slice(0, MAX_PLAN_CHARS)}\n[truncated for evaluation]`
}

/** What a judge is told the plans are. */
export const STAGE_TEXT: Record<JudgeStage, string> = {
  solo: "One agent's independent draft, judged alone: no other agent has seen it",
  draft: 'Independent drafts: no agent has seen another agent’s plan yet',
  review: 'Cross-reviewed plans: each agent has read every other plan and revised its own',
}
export const disputeKey = (index: number) => `dispute_${String(index + 1)}` as DisputeKey

function agentOptions(plans: readonly JudgedPlan[], describe: (label: string) => string) {
  return Object.fromEntries(plans.map(({ agent, label }) => [agent, describe(label)]))
}

function labelOf(plans: readonly JudgedPlan[], agent: AgentName): string {
  return plans.find((plan) => plan.agent === agent)?.label ?? agent
}

function disputeQuestion(
  plans: readonly JudgedPlan[],
  dispute: Dispute,
): PlanQuestion & { readonly kind: 'choice' } {
  const critics = dispute.critics.map((critic) => labelOf(plans, critic)).join(' and ')
  const author = labelOf(plans, dispute.target)
  return {
    kind: 'choice',
    ask: `${critics} objected to ${author}'s plan, and ${author} rejected the objection. Judging from the plans, which side is right?`,
    details: {
      claim: dispute.claim,
      why: dispute.reasons,
      rejection: dispute.rejections,
      check: dispute.check
        ? `${dispute.check.result.toUpperCase()}${dispute.check.evidence ? `: ${dispute.check.evidence}` : ''}`
        : 'not checked',
    },
    options: {
      critic: `${critics}'s objection holds`,
      author: `${author}'s position holds`,
      unclear: 'The material does not settle it',
    },
    fallback: 'unclear',
  }
}

/** Whether the plan could be the final plan: the strongest plan, or a lone draft. */
function standsAlone(stage: JudgeStage): PlanQuestion & { readonly kind: 'binary' } {
  // A judge that has failed never adopts a plan: the run synthesizes instead.
  return stage === 'solo'
    ? {
        kind: 'binary',
        ask: 'Could this plan, as it stands, be handed to an implementer as the final plan, with no review or merge?',
        yes: 'The plan is complete and self-contained; ready to implement',
        no: 'The plan has gaps that review or another plan would need to fill',
        fallback: 0,
      }
    : {
        kind: 'binary',
        ask: 'Could the strongest plan be handed to an implementer as the final plan, with no merge of the others?',
        yes: 'One plan is already complete and self-contained; merging would add nothing material',
        no: 'The plans hold complementary material that a final merge has to combine',
        fallback: 0,
      }
}

/** A rubric of four levels; a judge that cannot answer claims the lowest. */
function rubric(ask: string, levels: readonly string[]): PlanQuestion & { readonly kind: 'score' } {
  return { kind: 'score', ask, levels, fallback: 0 }
}

/**
 * Every question of one judgement, in the order a verdict reads them. The
 * `finalizer` falls back to the first plan's agent, so it is always an agent.
 */
export function planQuestions(input: {
  plans: readonly JudgedPlan[]
  stage: JudgeStage
  disputes?: readonly Dispute[]
}): PlanQuestions {
  const { plans, stage } = input
  const disputes: Record<DisputeKey, PlanQuestion & { readonly kind: 'choice' }> = {}
  input.disputes?.forEach((dispute, index) => {
    disputes[disputeKey(index)] = disputeQuestion(plans, dispute)
  })
  return {
    stronger_plan: {
      kind: 'choice',
      ask: 'Which plan is most likely to lead to a correct, efficient implementation of the task?',
      options: {
        ...agentOptions(plans, (label) => `${label}'s plan is materially stronger overall`),
        tie: 'No plan is materially stronger, or their strengths are complementary',
      },
      fallback: 'tie',
    },
    finalizer: {
      kind: 'choice',
      ask: "Which agent's plan demonstrates the best judgment for merging all the plans into the final plan?",
      options: agentOptions(plans, (label) => `${label} should perform the final synthesis`),
      fallback: plans[0]?.agent ?? 'tie',
    },
    completeness: rubric('How complete is the combined planning material for the requested task?', [
      'Major requirements or repository impacts are missing',
      'Several important details are missing',
      'Mostly complete, with minor gaps',
      'Complete and implementation-ready',
    ]),
    feasibility: rubric(
      'How feasible and repository-grounded are the proposed implementation steps?',
      [
        'Mostly speculative or incompatible with the repository',
        'Partly grounded but contains risky assumptions',
        'Mostly grounded and feasible',
        'Highly concrete, minimal, and feasible',
      ],
    ),
    risk_coverage: rubric('How well do the plans cover edge cases, tests, and rollout risks?', [
      'Risks are largely absent',
      'Only obvious risks are covered',
      'Important risks and tests are covered',
      'Risk, testing, and rollout coverage is thorough',
    ]),
    // A judge that has failed never buys another billed round.
    needs_another_pass: {
      kind: 'binary',
      ask: 'Would a cross-review round, each agent revising its plan against all the others, materially improve the final implementation plan?',
      yes: 'Important contradictions, omissions, or unsupported assumptions remain',
      no: 'The material is ready for final synthesis',
      fallback: 0,
    },
    stands_alone: standsAlone(stage),
    ...disputes,
  }
}

/** The plans as a judge sees them: keyed by agent name, the names the choices answer with. */
export function judgedPlans(
  plans: readonly JudgedPlan[],
): Record<AgentName, { author: string; plan: string }> {
  return Object.fromEntries(
    plans.map(({ agent, label, plan }) => [agent, { author: label, plan: bounded(plan) }]),
  )
}
