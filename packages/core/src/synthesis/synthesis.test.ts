import { describe, expect, it } from 'vitest'
import { Planner } from '../orchestrator/orchestrator.js'
import { verdict, FakeAgent, FakeJev, task } from '../orchestrator/orchestrator.fixtures.js'
import type { PlanJudge } from '../questions/questions.types.js'
import type { PlanRound } from '../orchestrator/orchestrator.types.js'

describe('Planner synthesis in balanced mode', () => {
  it('answers with the strongest cross-reviewed plan when Jev judges it final as it stands', async () => {
    const codex = new FakeAgent('codex', ['codex draft', 'codex revised'])
    const claude = new FakeAgent('claude', ['claude draft', 'claude revised'])
    const jev = new FakeJev([
      { needsAnotherPassProbability: 0.9 },
      { strongerPlan: 'codex', standsAloneProbability: 0.8 },
    ])
    const stages: string[] = []

    const result = await new Planner([codex, claude], jev).plan({
      ...task,
      onStage: (message) => stages.push(message),
    })

    expect(result.plan).toBe('codex revised')
    expect(result.finalizer).toBe('codex')
    expect(result.cost).toMatchObject({ synthesized: false, agentCalls: 4, reviewRounds: 1 })
    expect(claude.prompts).toHaveLength(2)
    expect(stages.at(-1)).toBe("Adopting Codex's plan: Jev judged it final as it stands…")
  })

  it("adopts the finalizer's plan when Jev calls the cross-reviewed plans tied", async () => {
    const codex = new FakeAgent('codex', ['codex draft', 'codex revised'])
    const claude = new FakeAgent('claude', ['claude draft', 'claude revised'])
    const jev = new FakeJev([
      { needsAnotherPassProbability: 0.9 },
      { strongerPlan: 'tie', finalizer: 'claude', standsAloneProbability: 0.8 },
    ])

    const result = await new Planner([codex, claude], jev).plan(task)

    expect(result).toMatchObject({ plan: 'claude revised', finalizer: 'claude' })
  })

  it('merges anyway when no plan has been cross-reviewed, however final Jev calls one', async () => {
    const codex = new FakeAgent('codex', ['codex draft'])
    const claude = new FakeAgent('claude', ['claude draft', 'final plan'])
    const jev = new FakeJev([{ standsAloneProbability: 0.99, strongerPlan: 'codex' }])

    const result = await new Planner([codex, claude], jev).plan(task)

    expect(result).toMatchObject({ plan: 'final plan', finalizer: 'claude' })
    expect(result.cost).toMatchObject({ synthesized: true, reviewRounds: 0 })
  })

  it('merges anyway when the finalizer is pinned', async () => {
    const codex = new FakeAgent('codex', ['codex draft', 'codex revised', 'codex final'])
    const claude = new FakeAgent('claude', ['claude draft', 'claude revised'])
    const jev = new FakeJev([
      { needsAnotherPassProbability: 0.9 },
      { strongerPlan: 'claude', standsAloneProbability: 0.99 },
    ])

    const result = await new Planner([codex, claude], jev).plan({ ...task, finalizer: 'codex' })

    expect(result).toMatchObject({ plan: 'codex final', finalizer: 'codex' })
    expect(result.cost).toMatchObject({ synthesized: true })
  })

  it('falls back to the merge, and to its own check, when Jev names no plan it can point at', async () => {
    const codex = new FakeAgent('codex', ['codex draft', 'codex revised'])
    const claude = new FakeAgent('claude', ['claude draft', 'claude revised'])
    const jev = new FakeJev([
      { needsAnotherPassProbability: 0.9 },
      { strongerPlan: 'ghost', finalizer: 'ghost', standsAloneProbability: 0.99 },
    ])

    await expect(new Planner([codex, claude], jev).plan(task)).rejects.toThrow(
      '"ghost" is not one of',
    )
  })
})

describe('Planner synthesis in ultra mode', () => {
  const ultra = { ...task, mode: 'ultra' } as const

  describe('selectStronger', () => {
    const options = { ...ultra, selectStronger: true }

    it('returns the stronger revised plan as it is, with no synthesis call', async () => {
      const codex = new FakeAgent('codex', ['codex draft', 'codex revised'])
      const claude = new FakeAgent('claude', ['claude draft', 'claude revised'])
      const jev: PlanJudge = {
        name: 'Jev',
        judge: async () => ({ ...verdict, strongerPlan: 'codex' }),
      }
      const stages: string[] = []
      const rounds: PlanRound[] = []
      const result = await new Planner([codex, claude], jev).plan({
        ...options,
        onStage: (message) => stages.push(message),
        onRound: (round) => {
          rounds.push(round)
        },
      })
      expect(result).toMatchObject({ plan: 'codex revised', finalizer: 'codex', selected: true })
      expect(result.timings.rounds.map(({ stage }) => stage)).toEqual(['draft', 'review', 'final'])
      expect(codex.prompts).toHaveLength(2)
      expect(claude.prompts).toHaveLength(2)
      expect(stages.at(-1)).toBe("Jev rated Codex's plan stronger; using it without a synthesis…")
      expect(rounds.at(-1)).toMatchObject({
        stage: 'final',
        plans: { codex: 'codex revised' },
        selected: true,
        timings: { agents: {} },
      })
    })

    it('still has the finalizer merge the plans on a tie', async () => {
      const codex = new FakeAgent('codex', ['codex draft', 'codex revised'])
      const claude = new FakeAgent('claude', ['claude draft', 'claude revised', 'final plan'])
      const rounds: PlanRound[] = []
      const result = await new Planner([codex, claude], new FakeJev()).plan({
        ...options,
        onRound: (round) => {
          rounds.push(round)
        },
      })
      expect(result).toMatchObject({ plan: 'final plan', finalizer: 'claude' })
      expect(result).not.toHaveProperty('selected')
      expect(rounds.at(-1)).not.toHaveProperty('selected')
    })

    it('merges when no cross-review ran, whatever plan Jev rates stronger', async () => {
      const codex = new FakeAgent('codex', ['codex draft'])
      const claude = new FakeAgent('claude', ['claude draft', 'final plan'])
      const jev = new FakeJev([{ strongerPlan: 'codex', standsAloneProbability: 0.9 }])
      const result = await new Planner([codex, claude], jev).plan({ ...task, selectStronger: true })
      expect(result).toMatchObject({ plan: 'final plan', finalizer: 'claude' })
      expect(result).not.toHaveProperty('selected')
      expect(result.cost).toMatchObject({ reviewRounds: 0, synthesized: true })
    })
  })
})
