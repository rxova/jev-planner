import { describe, expect, it } from 'vitest'
import { bounded, disputeKey, planQuestions, judgedPlans } from '../questions.js'

const plans = [
  { agent: 'codex', label: 'Codex', plan: 'a' },
  { agent: 'claude', label: 'Claude', plan: 'b' },
]

describe('planQuestions', () => {
  it('falls back to what a failed judge can do without harm', () => {
    const questions = planQuestions({ plans, stage: 'review' })
    // No other billed round, no adoption, a synthesis, by a real agent.
    expect(questions.needs_another_pass.fallback).toBe(0)
    expect(questions.stands_alone.fallback).toBe(0)
    expect(questions.stronger_plan.fallback).toBe('tie')
    expect(questions.finalizer.fallback).toBe('codex')
    expect(questions.completeness.fallback).toBe(0)
  })

  it('offers each agent, and tie only for the stronger plan', () => {
    const questions = planQuestions({ plans, stage: 'draft' })
    expect(Object.keys(questions.stronger_plan.options)).toEqual(['codex', 'claude', 'tie'])
    expect(Object.keys(questions.finalizer.options)).toEqual(['codex', 'claude'])
  })

  it('asks the solo stands-alone question of a lone draft', () => {
    expect(planQuestions({ plans, stage: 'solo' }).stands_alone.ask).toContain(
      'with no review or merge',
    )
    expect(planQuestions({ plans, stage: 'review' }).stands_alone.ask).toContain(
      'with no merge of the others',
    )
  })

  it('keys one question per dispute, with unclear as its fallback', () => {
    const dispute = {
      target: 'claude',
      critics: ['codex', 'glm'],
      objections: ['codex:claude:C1'],
      claim: 'x is missing',
      reasons: ['r'],
      rejections: ['j'],
      repo: true,
    }
    const questions = planQuestions({
      plans,
      stage: 'review',
      disputes: [
        { ...dispute, id: 'D1', check: { checker: 'codex', result: 'confirm', evidence: '' } },
        { ...dispute, id: 'D2' },
        {
          ...dispute,
          id: 'D3',
          check: { checker: 'codex', result: 'refute', evidence: 'src/a.ts has x' },
        },
      ],
    })
    expect(questions[disputeKey(0)]).toMatchObject({
      ask: expect.stringContaining("Codex and glm objected to Claude's plan") as unknown,
      details: { claim: 'x is missing', check: 'CONFIRM' },
      fallback: 'unclear',
    })
    expect(questions[disputeKey(1)]?.details).toMatchObject({ check: 'not checked' })
    expect(questions[disputeKey(2)]?.details).toMatchObject({ check: 'REFUTE: src/a.ts has x' })
    expect(Object.keys(questions)).not.toContain('dispute_4')
  })

  it('falls the finalizer back to tie only when there is no plan', () => {
    expect(planQuestions({ plans: [], stage: 'draft' }).finalizer.fallback).toBe('tie')
  })
})

describe('judgedPlans', () => {
  it('keys the plans by agent and cuts long ones', () => {
    expect(judgedPlans([{ agent: 'codex', label: 'Codex', plan: 'x'.repeat(40_001) }])).toEqual({
      codex: { author: 'Codex', plan: bounded('x'.repeat(40_001)) },
    })
    expect(bounded('short')).toBe('short')
    expect(bounded('x'.repeat(40_001))).toMatch(/\[truncated for evaluation\]$/)
  })
})
