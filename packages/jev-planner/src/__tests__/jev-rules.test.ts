import { describe, expect, it } from 'vitest'
import { disputeKey } from '../jev-questions.js'
import { claimCheck, jevRules, jevSkips, tooShort, TOO_SHORT_CHARS } from '../jev-rules.js'
import type { JevState } from '../jev-rules.js'
import type { ClaimCheck } from '../types.js'

const state = (plans: string[], check: ClaimCheck | null = null): JevState => ({
  task: 't',
  stage: 's',
  plans: Object.fromEntries(
    plans.map((plan, index) => [`a${String(index)}`, { author: 'A', plan }]),
  ),
  disputes: {
    [disputeKey(0)]: { critics: 'B', author: 'A', claim: 'c', why: [], rejection: [], check },
  },
})

describe('tooShort', () => {
  it('rules the plans cannot stand alone only when every one is short, whitespace aside', () => {
    const short = `${'x'.repeat(TOO_SHORT_CHARS - 1)}${' \n'.repeat(50)}`
    expect(tooShort.decide(state([short, '']))).toEqual({ probability: 0 })
    expect(tooShort.decide(state([short, 'x'.repeat(TOO_SHORT_CHARS)]))).toBeUndefined()
  })
})

describe('claimCheck', () => {
  const check = (result: ClaimCheck['result']): ClaimCheck => ({
    checker: 'codex',
    result,
    evidence: '',
  })
  const rule = claimCheck(disputeKey(0))

  it('sides with the critics on a confirm and the author on a refute, short of certain', () => {
    expect(rule.id).toBe('claim-check')
    expect(rule.decide(state([], check('confirm')))).toEqual({ choice: 'critic', confidence: 0.8 })
    expect(rule.decide(state([], check('refute')))).toEqual({ choice: 'author', confidence: 0.8 })
  })

  it('leaves an unknown result, an unchecked claim and a missing dispute to the panel', () => {
    expect(rule.decide(state([], check('unknown')))).toBeUndefined()
    expect(rule.decide(state([]))).toBeUndefined()
    expect(claimCheck(disputeKey(4)).decide({ task: 't', stage: 's', plans: {} })).toBeUndefined()
  })
})

describe('jevRules', () => {
  it('always has too-short, and claim-check per dispute only when turned on', () => {
    const keys = [disputeKey(0), disputeKey(1)]
    expect(Object.keys(jevRules(keys))).toEqual(['stands_alone'])
    expect(Object.keys(jevRules(keys, { claimChecks: true }))).toEqual([
      'stands_alone',
      'dispute_1',
      'dispute_2',
    ])
  })
})

describe('jevSkips', () => {
  it('skips another pass once the review rounds are used', () => {
    expect(jevSkips('review', { reviewRounds: 1, maxReviewRounds: 1 })).toEqual([
      'needs_another_pass',
    ])
    expect(jevSkips('review', { reviewRounds: 0, maxReviewRounds: 1 })).toEqual([])
    expect(jevSkips('solo', undefined)).toEqual([])
  })

  it('skips what the planner never reads of a draft verdict', () => {
    expect(jevSkips('draft', { reviewRounds: 0, maxReviewRounds: 0 })).toEqual([
      'needs_another_pass',
      'stronger_plan',
      'stands_alone',
    ])
  })
})
