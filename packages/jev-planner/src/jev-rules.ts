import type { Rule } from '@rxova/journey-judge'
import type { DisputeKey, JevQuestions, Stage } from './jev-questions.js'
import type { AgentName, ClaimCheck, JevJudge } from './types.js'

/** What the graph judge's panel reads, and what its rules decide from. */
export interface JevState {
  task: string
  /** What the plans are: `STAGE_TEXT` for the stage. */
  stage: string
  /** Keyed by agent name, the names the choices answer with. */
  plans: Record<AgentName, { author: string; plan: string }>
  /** Each dispute, keyed as its question is. */
  disputes?: Record<
    DisputeKey,
    {
      critics: string
      author: string
      claim: string
      why: readonly string[]
      rejection: readonly string[]
      check: ClaimCheck | null
    }
  >
}

/** Below this many characters, not counting whitespace, a plan cannot be a final plan. */
export const TOO_SHORT_CHARS = 200

type Rules = { readonly [K in keyof JevQuestions]?: readonly Rule<JevQuestions[K], JevState>[] }

/**
 * `too-short`: when every plan is empty or shorter than `TOO_SHORT_CHARS`, the
 * strongest one cannot be a final plan either, so `stands_alone` is 0.
 */
export const tooShort: Rule<JevQuestions['stands_alone'], JevState> = {
  id: 'too-short',
  decide: (state) =>
    Object.values(state.plans).every(({ plan }) => plan.replace(/\s/g, '').length < TOO_SHORT_CHARS)
      ? { probability: 0 }
      : undefined,
}

/**
 * `claim-check`: a dispute whose claim an agent checked in the repository is
 * settled by the check: `confirm` for the critics, `refute` for the author.
 * `unknown` leaves it to the panel. One checker can be wrong, so the ruling's
 * confidence is 0.8, not 1.
 */
export function claimCheck(key: DisputeKey): Rule<JevQuestions[DisputeKey], JevState> {
  return {
    id: 'claim-check',
    decide: (state) => {
      const result = state.disputes?.[key]?.check?.result
      if (result === 'confirm') return { choice: 'critic', confidence: 0.8 }
      if (result === 'refute') return { choice: 'author', confidence: 0.8 }
      return undefined
    },
  }
}

/** The rules for one judgement. `claimChecks` turns on `claim-check`, which is off by default. */
export function jevRules(
  disputes: readonly DisputeKey[],
  options: { claimChecks?: boolean } = {},
): Rules {
  const rules: Record<string, readonly Rule<never, JevState>[]> = { stands_alone: [tooShort] }
  if (options.claimChecks) for (const key of disputes) rules[key] = [claimCheck(key)]
  return rules
}

type Progress = NonNullable<Parameters<JevJudge['judge']>[0]['progress']>

/**
 * The questions whose answer cannot change what the run does next, so they
 * take their fallback without a call: another pass once the run has used its
 * review rounds, and the stronger plan and whether it stands alone before any
 * review, where the planner reads neither.
 */
export function jevSkips(stage: Stage, progress: Progress | undefined): (keyof JevQuestions)[] {
  const skips: (keyof JevQuestions)[] = []
  if (progress && progress.reviewRounds >= progress.maxReviewRounds) {
    skips.push('needs_another_pass')
  }
  if (stage === 'draft') skips.push('stronger_plan', 'stands_alone')
  return skips
}
