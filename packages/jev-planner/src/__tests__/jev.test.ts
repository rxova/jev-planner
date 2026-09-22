import { TypeSafeClient } from '@typesafe-ai/sdk'
import { describe, expect, it } from 'vitest'
import { TypeSafeJevJudge } from '../jev.js'

function fakeClient(extraAnswers: Record<string, unknown> = {}): {
  client: TypeSafeClient
  requests: Record<string, unknown>[]
} {
  const requests: Record<string, unknown>[] = []
  const client = new TypeSafeClient({
    apiKey: 'test-key',
    fetch: async (_url, init) => {
      requests.push(JSON.parse(init?.body as string) as Record<string, unknown>)
      return new Response(
        JSON.stringify({
          model: 'jev-test',
          answers: {
            stronger_plan: {
              type: 'choice',
              choice: 'tie',
              confidence: 0.2,
              probabilities: { codex: 0.4, claude: 0.4, tie: 0.2 },
            },
            finalizer: {
              type: 'choice',
              choice: 'claude',
              confidence: 0.8,
              probabilities: { codex: 0.1, claude: 0.9 },
            },
            completeness: {
              type: 'score',
              score: 2.8,
              confidence: 0.9,
              legend: { 0: 'a', 1: 'b', 2: 'c', 3: 'd' },
              probabilities: { 0: 0, 1: 0, 2: 0.2, 3: 0.8 },
            },
            feasibility: {
              type: 'score',
              score: 2.9,
              confidence: 0.9,
              legend: { 0: 'a', 1: 'b', 2: 'c', 3: 'd' },
              probabilities: { 0: 0, 1: 0, 2: 0.1, 3: 0.9 },
            },
            risk_coverage: {
              type: 'score',
              score: 2.7,
              confidence: 0.8,
              legend: { 0: 'a', 1: 'b', 2: 'c', 3: 'd' },
              probabilities: { 0: 0, 1: 0, 2: 0.3, 3: 0.7 },
            },
            needs_another_pass: { type: 'noul', noul: 0.1 },
            stands_alone: { type: 'noul', noul: 0.85 },
            ...extraAnswers,
          },
          usage: { input_tokens: 100, output_tokens: 20 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    },
  })
  return { client, requests }
}

describe('TypeSafeJevJudge', () => {
  it('sends typed questions and maps the Jev response', async () => {
    const { client, requests } = fakeClient()
    const result = await new TypeSafeJevJudge(client).judge({
      task: 'task',
      plans: [
        { agent: 'codex', label: 'Codex', plan: 'codex' },
        { agent: 'claude', label: 'Claude', plan: 'claude' },
      ],
      stage: 'review',
      model: 'jev-test',
    })

    expect(result).toMatchObject({
      strongerPlan: 'tie',
      finalizer: 'claude',
      completeness: 2.8,
      needsAnotherPassProbability: 0.1,
      standsAloneProbability: 0.85,
      model: 'jev-test',
    })
    expect(requests[0]?.model).toBe('jev-test')
    expect(Object.keys(requests[0]?.questions as object)).toHaveLength(7)
  })

  it("offers each agent's name as a choice, and keys the plans by it", async () => {
    const { client, requests } = fakeClient()
    await new TypeSafeJevJudge(client).judge({
      task: 'task',
      plans: [
        { agent: 'codex', label: 'Codex', plan: 'a' },
        { agent: 'deepseek', label: 'DeepSeek', plan: 'b' },
        { agent: 'glm', label: 'GLM', plan: 'c' },
      ],
      stage: 'draft',
    })

    const request = JSON.stringify(requests[0])
    for (const option of [
      "DeepSeek's plan is materially stronger overall",
      'GLM should perform the final synthesis',
      'No plan is materially stronger',
    ]) {
      expect(request).toContain(option)
    }
    expect((requests[0]?.state as { plans: unknown }).plans).toEqual({
      codex: { author: 'Codex', plan: 'a' },
      deepseek: { author: 'DeepSeek', plan: 'b' },
      glm: { author: 'GLM', plan: 'c' },
    })
  })

  it('tells Jev whether it is looking at drafts or at cross-reviewed plans', async () => {
    const judged = async (stage: 'draft' | 'review') => {
      const { client, requests } = fakeClient()
      await new TypeSafeJevJudge(client).judge({
        task: 'task',
        plans: [
          { agent: 'codex', label: 'Codex', plan: 'a' },
          { agent: 'claude', label: 'Claude', plan: 'b' },
        ],
        stage,
      })
      return (requests[0]?.state as { stage: string }).stage
    }

    await expect(judged('draft')).resolves.toContain('no agent has seen another')
    await expect(judged('review')).resolves.toContain('each agent has read every other plan')
  })

  it("leaves the model to the SDK's default and truncates oversized plans", async () => {
    const { client, requests } = fakeClient()
    await new TypeSafeJevJudge(client).judge({
      task: 'task',
      plans: [
        { agent: 'codex', label: 'Codex', plan: 'x'.repeat(40_001) },
        { agent: 'claude', label: 'Claude', plan: 'short' },
      ],
      stage: 'review',
    })

    const plans = (requests[0]?.state as { plans: Record<string, { plan: string }> }).plans
    // No override is passed, so the SDK's own default goes out.
    expect(requests[0]?.model).toBe('jev-latest')
    expect(plans.codex?.plan).toBe(`${'x'.repeat(40_000)}\n[truncated for Jev evaluation]`)
    expect(plans.claude?.plan).toBe('short')
  })

  it('asks one choice per dispute and maps the rulings back to their ids', async () => {
    const { client, requests } = fakeClient({
      dispute_1: {
        type: 'choice',
        choice: 'author',
        confidence: 0.7,
        probabilities: { critic: 0.2, author: 0.7, unclear: 0.1 },
      },
    })
    const dispute = {
      target: 'claude',
      critics: ['codex', 'kimi'],
      objections: ['codex:claude:C1'],
      claim: 'runRound is missing',
      reasons: ['the plan calls it'],
      rejections: ['it exists'],
      repo: true,
    }
    const plans = [
      { agent: 'codex', label: 'Codex', plan: 'codex' },
      { agent: 'claude', label: 'Claude', plan: 'claude' },
    ]

    const result = await new TypeSafeJevJudge(client).judge({
      task: 'task',
      plans,
      stage: 'review',
      disputes: [
        {
          ...dispute,
          id: 'D1',
          check: { checker: 'codex', result: 'refute', evidence: 'src/a.ts' },
        },
        { ...dispute, id: 'D2', check: { checker: 'codex', result: 'unknown', evidence: '' } },
        { ...dispute, id: 'D3' },
      ],
    })

    const questions = requests[0]?.questions as Record<
      string,
      { instructions: unknown; criteria: unknown }
    >
    expect(questions.dispute_1).toEqual({
      type: 'choice',
      instructions: {
        question:
          "Codex and kimi objected to Claude's plan, and Claude rejected the objection. Judging from the plans, which side is right?",
        claim: 'runRound is missing',
        why: ['the plan calls it'],
        rejection: ['it exists'],
        check: 'REFUTE: src/a.ts',
      },
      criteria: {
        critic: "Codex and kimi's objection holds",
        author: "Claude's position holds",
        unclear: 'The material does not settle it',
      },
    })
    expect(questions.dispute_2?.instructions).toMatchObject({ check: 'UNKNOWN' })
    expect(questions.dispute_3?.instructions).toMatchObject({ check: 'not checked' })
    // A ruling the server leaves out reads as unsettled.
    expect(result.disputes).toEqual([
      { id: 'D1', choice: 'author', confidence: 0.7 },
      { id: 'D2', choice: 'unclear', confidence: 0 },
      { id: 'D3', choice: 'unclear', confidence: 0 },
    ])
  })

  it('asks no dispute questions and reports no rulings without disputes', async () => {
    const { client, requests } = fakeClient()
    const result = await new TypeSafeJevJudge(client).judge({
      task: 'task',
      plans: [{ agent: 'codex', label: 'Codex', plan: 'codex' }],
      stage: 'review',
      disputes: [],
    })
    expect(Object.keys(requests[0]?.questions as object)).not.toContain('dispute_1')
    expect(result.disputes).toBeUndefined()
  })
})
