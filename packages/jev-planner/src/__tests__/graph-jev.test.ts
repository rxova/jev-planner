import { describe, expect, it, vi } from 'vitest'
import type { CompletionRequest, JudgeModel } from '@rxova/journey-judge'
import { GraphJevJudge } from '../graph-jev.js'
import type { Dispute, JudgedPlan } from '../types.js'

const long = (text: string) => `${text} ${'x'.repeat(300)}`
const plans: JudgedPlan[] = [
  { agent: 'codex', label: 'Codex', plan: long('codex plan') },
  { agent: 'claude', label: 'Claude', plan: long('claude plan') },
]

/** What a panel model answers: an option's text, a binary point, or a score. */
type Fields = Record<string, string | number>

/** The label an option's text carries in this prompt. */
const labelOf = (prompt: string, text: string) =>
  new RegExp(`(option_[A-Z]): ${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\n`).exec(prompt)?.[1]

/** A panel model that answers each asked question from `fields(call)`. */
function panelist(fields: (call: number) => Fields, id = 'm') {
  let call = 0
  const complete = vi.fn((request: CompletionRequest) => {
    call += 1
    const answer = fields(call)
    const asked = Object.keys((request.schema as { properties: object }).properties)
    const reply = Object.fromEntries(
      asked.map((key) => {
        const value = answer[key]
        return [key, typeof value === 'string' ? (labelOf(request.prompt, value) ?? value) : value]
      }),
    )
    return Promise.resolve(JSON.stringify(reply))
  })
  return { id, complete } satisfies JudgeModel
}

const asked = (model: ReturnType<typeof panelist>) =>
  Object.keys(
    (model.complete.mock.calls[0]?.[0].schema as { properties: object } | undefined)?.properties ??
      {},
  )

const everything: Fields = {
  stronger_plan: "Claude's plan is materially stronger overall",
  finalizer: 'Codex should perform the final synthesis',
  completeness: 2,
  feasibility: 3,
  risk_coverage: 1,
  needs_another_pass: 'yes',
  stands_alone: 'no',
}

const dispute: Dispute = {
  id: 'D1',
  target: 'claude',
  critics: ['codex'],
  objections: ['codex:claude:C1'],
  claim: 'the cache is never cleared',
  reasons: ['r'],
  rejections: ['j'],
  repo: true,
}

describe('GraphJevJudge', () => {
  it("maps the panel's answers onto a verdict, with the trail", async () => {
    const model = panelist(() => everything)
    const verdict = await new GraphJevJudge({ panel: [model], samples: 1 }).judge({
      task: 'do it',
      plans,
      stage: 'review',
      progress: { reviewRounds: 1, maxReviewRounds: 2 },
    })
    expect(verdict).toMatchObject({
      strongerPlan: 'claude',
      strongerPlanConfidence: 1,
      finalizer: 'codex',
      finalizerConfidence: 1,
      completeness: 2,
      completenessConfidence: 1,
      feasibility: 3,
      riskCoverage: 1,
      needsAnotherPassProbability: 1,
      standsAloneProbability: 0,
      model: 'm',
    })
    expect(verdict).not.toHaveProperty('disputes')
    expect(verdict.trail?.calls).toBe(1)
    expect(verdict.trail?.answers.completeness).toMatchObject({ source: 'panel' })
    const [request] = model.complete.mock.calls[0] ?? []
    expect(request?.prompt).toContain('codex plan')
    expect(request?.prompt).toContain('Cross-reviewed plans')
  })

  it('keeps the finalizer an agent when the panel abstains or splits', async () => {
    const abstaining = await new GraphJevJudge({
      panel: [panelist(() => ({ ...everything, finalizer: 'nobody' }))],
      samples: 1,
      maxCalls: 2,
    }).judge({ task: 't', plans, stage: 'review' })
    expect(abstaining).toMatchObject({ finalizer: 'codex', finalizerConfidence: 0 })
    expect(abstaining.model).toBe('m abstained:finalizer')

    const split = await new GraphJevJudge({
      panel: [
        panelist((call) => ({
          ...everything,
          finalizer: `${call % 2 ? 'Claude' : 'Codex'} should perform the final synthesis`,
        })),
      ],
      samples: 2,
    }).judge({ task: 't', plans: [...plans].reverse(), stage: 'review' })
    // The first plan is Claude's here, so the fallback is Claude.
    expect(split.finalizer).toBe('claude')
  })

  it('asks a lone plan only what it can answer, and names its agent for the rest', async () => {
    const model = panelist(() => everything)
    const verdict = await new GraphJevJudge({ panel: [model], samples: 1 }).judge({
      task: 't',
      plans: [plans[0]!],
      stage: 'solo',
      progress: { reviewRounds: 0, maxReviewRounds: 0 },
    })
    expect(asked(model)).toEqual(['completeness', 'feasibility', 'risk_coverage', 'stands_alone'])
    expect(verdict).toMatchObject({
      strongerPlan: 'codex',
      strongerPlanConfidence: 1,
      finalizer: 'codex',
      finalizerConfidence: 1,
      needsAnotherPassProbability: 0,
    })
    expect(verdict.model).toBe('m rule:stronger_plan,finalizer')
  })

  it('makes no call for a question a rule settled or the run cannot use', async () => {
    const model = panelist(() => everything)
    const verdict = await new GraphJevJudge({ panel: [model], samples: 1 }).judge({
      task: 't',
      plans: plans.map((plan) => ({ ...plan, plan: 'short' })),
      stage: 'review',
      progress: { reviewRounds: 1, maxReviewRounds: 1 },
    })
    expect(asked(model)).not.toContain('needs_another_pass')
    expect(asked(model)).not.toContain('stands_alone')
    expect(verdict.standsAloneProbability).toBe(0)
    expect(verdict.model).toBe('m rule:stands_alone')
    expect(verdict.trail?.answers.needs_another_pass).toEqual({ source: 'skipped' })

    const draft = panelist(() => everything)
    await new GraphJevJudge({ panel: [draft], samples: 1 }).judge({
      task: 't',
      plans,
      stage: 'draft',
      progress: { reviewRounds: 0, maxReviewRounds: 1 },
    })
    expect(asked(draft)).toEqual([
      'finalizer',
      'completeness',
      'feasibility',
      'risk_coverage',
      'needs_another_pass',
    ])
  })

  it('rules on each dispute from the state, and lets a claim check settle one when on', async () => {
    const model = panelist(() => ({
      ...everything,
      dispute_1: "Codex's objection holds",
      dispute_2: "Claude's position holds",
      dispute_3: 'The material does not settle it',
    }))
    const verdict = await new GraphJevJudge({
      panel: [model],
      samples: 1,
      timeoutMs: 5_000,
      claimChecks: true,
    }).judge({
      task: 't',
      plans,
      stage: 'review',
      disputes: [
        { ...dispute, check: { checker: 'codex', result: 'refute', evidence: 'it is cleared' } },
        { ...dispute, id: 'D2' },
        { ...dispute, id: 'D3' },
      ],
    })
    expect(asked(model)).not.toContain('dispute_1')
    expect(verdict.disputes).toEqual([
      { id: 'D1', choice: 'author', confidence: 0.8 },
      { id: 'D2', choice: 'author', confidence: 1 },
      { id: 'D3', choice: 'unclear', confidence: 1 },
    ])
    expect(verdict.model).toBe('m rule:dispute_1')
    const [request] = model.complete.mock.calls[0] ?? []
    expect(request?.prompt).toContain('The dispute is `disputes.dispute_2` in the state.')
    expect(request?.prompt).toContain('the cache is never cleared')
    expect(request?.prompt).toContain('it is cleared')
  })

  it('leaves disputes to the panel without claim checks, and joins the panel ids', async () => {
    const reply = () => ({ ...everything, dispute_1: "Codex's objection holds" })
    const panel = [panelist(reply, 'a'), panelist(reply, 'b')]
    // The judge's default samples: every option in every position.
    const verdict = await new GraphJevJudge({ panel }).judge({
      task: 't',
      plans,
      stage: 'review',
      disputes: [{ ...dispute, check: { checker: 'codex', result: 'refute', evidence: '' } }],
    })
    expect(verdict.disputes).toEqual([{ id: 'D1', choice: 'critic', confidence: 1 }])
    expect(verdict.model).toBe('a+b')
  })
})
