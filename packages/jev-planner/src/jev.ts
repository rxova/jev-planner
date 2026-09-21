import { choice, noul, score, TypeSafeClient } from '@typesafe-ai/sdk'
import type { JevJudge, JevVerdict } from './types.js'

const MAX_PLAN_CHARS = 40_000

function bounded(text: string): string {
  if (text.length <= MAX_PLAN_CHARS) return text
  return `${text.slice(0, MAX_PLAN_CHARS)}\n[truncated for Jev evaluation]`
}

export class TypeSafeJevJudge implements JevJudge {
  constructor(private readonly client: TypeSafeClient = new TypeSafeClient()) {}

  async judge(input: {
    task: string
    codexPlan: string
    claudePlan: string
    model?: string
  }): Promise<JevVerdict> {
    const response = await this.client.systemOne({
      ...(input.model ? { model: input.model } : {}),
      state: {
        task: input.task,
        codex_revised_plan: bounded(input.codexPlan),
        claude_revised_plan: bounded(input.claudePlan),
      },
      questions: {
        stronger_plan: choice(
          'Which revised plan is more likely to lead to a correct, efficient implementation of the task?',
          {
            codex: 'Codex is materially stronger overall',
            claude: 'Claude is materially stronger overall',
            tie: 'The plans are similarly strong or have complementary strengths',
          },
        ),
        finalizer: choice(
          "Which agent's revised plan demonstrates better judgment for merging both plans into the final plan?",
          {
            codex: 'Codex should perform the final synthesis',
            claude: 'Claude should perform the final synthesis',
          },
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
          'Would another cross-review round materially improve the final implementation plan?',
          {
            true: 'Important contradictions, omissions, or unsupported assumptions remain',
            false: 'The material is ready for final synthesis',
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
      model: response.model,
    }
  }
}
