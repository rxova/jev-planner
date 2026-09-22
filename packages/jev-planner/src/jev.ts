import { choice, noul, score, TypeSafeClient } from '@typesafe-ai/sdk'
import type { JevJudge, JevVerdict, JudgedPlan } from './types.js'

const MAX_PLAN_CHARS = 40_000

function bounded(text: string): string {
  if (text.length <= MAX_PLAN_CHARS) return text
  return `${text.slice(0, MAX_PLAN_CHARS)}\n[truncated for Jev evaluation]`
}

function agentOptions(plans: readonly JudgedPlan[], describe: (label: string) => string) {
  return Object.fromEntries(plans.map(({ agent, label }) => [agent, describe(label)]))
}

export class TypeSafeJevJudge implements JevJudge {
  constructor(private readonly client: TypeSafeClient = new TypeSafeClient()) {}

  async judge(input: {
    task: string
    plans: readonly JudgedPlan[]
    stage: 'draft' | 'review'
    model?: string
  }): Promise<JevVerdict> {
    const response = await this.client.systemOne({
      ...(input.model ? { model: input.model } : {}),
      state: {
        task: input.task,
        stage:
          input.stage === 'draft'
            ? 'Independent drafts: no agent has seen another agent’s plan yet'
            : 'Cross-reviewed plans: each agent has read every other plan and revised its own',
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
        stands_alone: noul(
          'Could the strongest plan be handed to an implementer as the final plan, with no merge of the others?',
          {
            true: 'One plan is already complete and self-contained; merging would add nothing material',
            false: 'The plans hold complementary material that a final merge has to combine',
          },
        ),
      },
    })

    const answers = response.answers
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
      model: response.model,
    }
  }
}
