import { TypeSafeClient } from '@typesafe-ai/sdk'
import { describe, expect, it } from 'vitest'
import { TypeSafeJevJudge } from '../jev.js'

function fakeClient(): { client: TypeSafeClient; requests: Record<string, unknown>[] } {
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
      codexPlan: 'codex',
      claudePlan: 'claude',
      model: 'jev-test',
    })

    expect(result).toMatchObject({
      strongerPlan: 'tie',
      finalizer: 'claude',
      completeness: 2.8,
      needsAnotherPassProbability: 0.1,
      model: 'jev-test',
    })
    expect(requests[0]?.model).toBe('jev-test')
    expect(Object.keys(requests[0]?.questions as object)).toHaveLength(6)
  })

  it("leaves the model to the SDK's default and truncates oversized plans", async () => {
    const { client, requests } = fakeClient()
    await new TypeSafeJevJudge(client).judge({
      task: 'task',
      codexPlan: 'x'.repeat(40_001),
      claudePlan: 'short',
    })

    const state = requests[0]?.state as Record<string, string>
    // No override is passed, so the SDK's own default goes out.
    expect(requests[0]?.model).toBe('jev-latest')
    expect(state.codex_revised_plan).toBe(`${'x'.repeat(40_000)}\n[truncated for Jev evaluation]`)
    expect(state.claude_revised_plan).toBe('short')
  })
})
