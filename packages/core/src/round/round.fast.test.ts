import { afterEach, describe, expect, it, vi } from 'vitest'
import { Planner } from '../orchestrator/orchestrator.js'
import {
  verdict,
  straggler,
  late,
  FakeAgent,
  FakeJev,
  task,
} from '../orchestrator/orchestrator.fixtures.js'
import type { PlanningAgent } from '../provider/provider.types.js'
import type { PlanJudge } from '../questions/questions.types.js'
import type { PlanRound } from '../orchestrator/orchestrator.types.js'

describe('Planner in fast mode', () => {
  const fast = { ...task, mode: 'fast' } as const
  const accept = { standsAloneProbability: 0.8 }

  afterEach(() => {
    vi.useRealTimers()
  })

  it('answers with the first draft Jev accepts alone, and stops the others', async () => {
    const aborts: string[] = []
    const codex = new FakeAgent('codex', [straggler(aborts)])
    const claude = new FakeAgent('claude', ['claude draft'])
    const jev = new FakeJev([accept])
    const stages: string[] = []
    const rounds: PlanRound[] = []

    const result = await new Planner([codex, claude], jev).plan({
      ...fast,
      onStage: (message) => stages.push(message),
      onRound: (round) => {
        rounds.push(round)
      },
    })

    expect(result).toMatchObject({ plan: 'claude draft', finalizer: 'claude', selected: true })
    expect(result.drafts).toEqual({ claude: 'claude draft' })
    expect(codex.requests[0]?.signal?.aborted).toBe(true)
    expect(aborts).toEqual(['aborted'])
    expect(jev.inputs).toMatchObject([
      { stage: 'solo', plans: [{ agent: 'claude', label: 'Claude', plan: 'claude draft' }] },
    ])
    expect(result.cost).toEqual({
      mode: 'fast',
      reviewMode: 'standard',
      reviewRounds: 0,
      synthesized: false,
      agentCalls: 2,
      judgeCalls: 1,
      dropped: ['codex'],
    })
    expect(stages).toEqual([
      'Drafting independent plans with Codex and Claude…',
      "Jev is judging Claude's draft alone…",
      "Jev accepted Claude's draft; stopping Codex…",
      "Adopting Claude's plan: Jev judged it final as it stands…",
    ])
    expect(rounds.map(({ stage, selected }) => ({ stage, selected }))).toEqual([
      { stage: 'draft', selected: undefined },
      { stage: 'final', selected: true },
    ])
    expect(rounds[0]?.verdict).toMatchObject(accept)
    expect(Object.keys(result.timings.rounds[0]?.agents ?? {})).toEqual(['claude'])
  })

  it('judges the next draft when Jev turns the first down', async () => {
    const codex = new FakeAgent('codex', [late('codex draft')])
    const claude = new FakeAgent('claude', ['claude draft'])
    const jev = new FakeJev([{ standsAloneProbability: 0.3 }, accept])
    const stages: string[] = []

    const result = await new Planner([codex, claude], jev).plan({
      ...fast,
      stragglerGraceMs: 1,
      onStage: (message) => stages.push(message),
    })

    expect(result).toMatchObject({ plan: 'codex draft', finalizer: 'codex', selected: true })
    expect(jev.inputs.map(({ stage, plans }) => [stage, plans.map(({ agent }) => agent)])).toEqual([
      ['solo', ['claude']],
      ['solo', ['codex']],
    ])
    // Two agents: the grace never cuts below two drafts, so the slower one was waited for.
    expect(result.cost.dropped).toEqual([])
    expect(stages).toContain("Jev judged Claude's draft not final on its own (0.30)…")
  })

  it('merges the drafts, with no cross-review, when Jev accepts none', async () => {
    const codex = new FakeAgent('codex', ['codex draft'])
    const claude = new FakeAgent('claude', ['claude draft', 'final plan'])
    const jev = new FakeJev([{}, {}, { needsAnotherPassProbability: 0.9 }])

    const result = await new Planner([codex, claude], jev).plan({ ...fast, stragglerGraceMs: 0 })

    expect(result.plan).toBe('final plan')
    expect(result.selected).toBeUndefined()
    expect(jev.inputs.map(({ stage }) => stage)).toEqual(['solo', 'solo', 'draft'])
    expect(jev.input?.plans.map(({ agent }) => agent)).toEqual(['codex', 'claude'])
    expect(claude.prompts).toHaveLength(2)
    expect(claude.prompts[1]).toContain('codex draft')
    expect(claude.prompts[1]).toContain('claude draft')
    expect(result.cost).toMatchObject({
      reviewRounds: 0,
      synthesized: true,
      agentCalls: 3,
      judgeCalls: 3,
    })
  })

  it('judges one draft at a time, in the order they arrive', async () => {
    const codex = new FakeAgent('codex', [late('codex draft')])
    const claude = new FakeAgent('claude', ['claude draft', 'final plan'])
    const glm = new FakeAgent('glm', ['glm draft'])
    let inFlight = 0
    let most = 0
    const judged: string[] = []
    const jev: PlanJudge = {
      name: 'Jev',
      judge: async (input) => {
        inFlight += 1
        most = Math.max(most, inFlight)
        judged.push(`${input.stage}:${input.plans.map(({ agent }) => agent).join(',')}`)
        await new Promise((done) => setTimeout(done, 2))
        inFlight -= 1
        return verdict
      },
    }

    await new Planner([codex, claude, glm], jev).plan(fast)

    expect(most).toBe(1)
    expect(judged).toEqual(['solo:claude', 'solo:glm', 'solo:codex', 'draft:codex,claude,glm'])
  })

  it('accepts a draft at the threshold and turns one down just below it', async () => {
    const run = async (standsAloneProbability: number) => {
      const codex = new FakeAgent('codex', ['codex draft'])
      const claude = new FakeAgent('claude', ['claude draft', 'final plan'])
      const result = await new Planner(
        [codex, claude],
        new FakeJev([{ standsAloneProbability }, {}, {}]),
      ).plan(fast)
      return result.selected ?? false
    }
    await expect(run(0.5)).resolves.toBe(true)
    await expect(run(0.49)).resolves.toBe(false)
  })

  it('keeps a draft that arrived while another was being accepted, and does not judge it', async () => {
    const codex = new FakeAgent('codex', [straggler()])
    const claude = new FakeAgent('claude', ['claude draft'])
    const glm = new FakeAgent('glm', ['glm draft'])
    const jev = new FakeJev([accept])

    const result = await new Planner([codex, claude, glm], jev).plan(fast)

    expect(jev.inputs).toHaveLength(1)
    expect(result.drafts).toEqual({ claude: 'claude draft', glm: 'glm draft' })
    expect(result.cost.dropped).toEqual(['codex'])
  })

  it('stops waiting for a straggler once two drafts are in, and merges those', async () => {
    const codex = new FakeAgent('codex', [straggler()])
    const claude = new FakeAgent('claude', ['claude draft', 'final plan'])
    const glm = new FakeAgent('glm', ['glm draft'])
    const jev = new FakeJev()
    const stages: string[] = []

    const result = await new Planner([codex, claude, glm], jev).plan({
      ...fast,
      stragglerGraceMs: 1,
      onStage: (message) => stages.push(message),
    })

    expect(result.cost.dropped).toEqual(['codex'])
    expect(stages).toContain('Codex is still working; the round goes on without it…')
    expect(jev.inputs.map(({ stage }) => stage)).toEqual(['solo', 'solo', 'draft'])
    expect(jev.input?.plans.map(({ agent }) => agent)).toEqual(['claude', 'glm'])
    expect(result.plan).toBe('final plan')
  })

  it('accepts a draft whatever the finalizer override, which only picks who merges', async () => {
    const accepted = await new Planner(
      [new FakeAgent('codex', ['codex draft']), new FakeAgent('claude', ['claude draft'])],
      new FakeJev([accept]),
    ).plan({ ...fast, finalizer: 'claude' })
    expect(accepted).toMatchObject({ selected: true, finalizer: 'codex' })

    const codex = new FakeAgent('codex', ['codex draft', 'codex merge'])
    const merged = await new Planner(
      [codex, new FakeAgent('claude', ['claude draft'])],
      new FakeJev(),
    ).plan({ ...fast, finalizer: 'codex', selectStronger: true })
    expect(merged).toMatchObject({ plan: 'codex merge', finalizer: 'codex' })
    expect(merged.selected).toBeUndefined()
  })

  it('adds every Jev call in the draft round to its timings', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'performance'] })
    const slow = (name: string, calls: [string, number][]): PlanningAgent => ({
      name,
      label: name,
      generate: async () => {
        const [plan, ms] = calls.shift() ?? ['', 0]
        await new Promise((done) => setTimeout(done, ms))
        return plan
      },
    })
    const jev: PlanJudge = {
      name: 'Jev',
      judge: async () => {
        await new Promise((done) => setTimeout(done, 400))
        return verdict
      },
    }
    const running = new Planner(
      [
        slow('codex', [['codex draft', 3_000]]),
        slow('claude', [
          ['claude draft', 1_000],
          ['final', 500],
        ]),
      ],
      jev,
    ).plan(fast)
    await vi.runAllTimersAsync()
    const { timings } = await running

    expect(timings.rounds).toEqual([
      {
        round: 1,
        stage: 'draft',
        totalMs: 3_800,
        agents: { codex: 3_000, claude: 1_000 },
        judgeMs: 1_200,
      },
      { round: 2, stage: 'final', totalMs: 500, agents: { claude: 500 } },
    ])
  })

  it('stops the agents still drafting when Jev fails', async () => {
    const aborts: string[] = []
    const codex = new FakeAgent('codex', [straggler(aborts)])
    const claude = new FakeAgent('claude', ['claude draft'])
    const jev: PlanJudge = { name: 'Jev', judge: () => Promise.reject(new Error('jev down')) }

    await expect(new Planner([codex, claude], jev).plan(fast)).rejects.toThrow('jev down')
    expect(aborts).toEqual(['aborted'])
  })

  it('fails when an agent fails before a draft is accepted, even mid-judgement', async () => {
    const codex = new FakeAgent('codex', [
      () =>
        new Promise<string>((_resolve, reject) =>
          setTimeout(() => reject(new Error('codex exploded')), 1),
        ),
    ])
    const claude = new FakeAgent('claude', ['claude draft'])
    const jev: PlanJudge = {
      name: 'Jev',
      judge: async () => {
        await new Promise((done) => setTimeout(done, 10))
        return { ...verdict, ...accept }
      },
    }

    await expect(new Planner([codex, claude], jev).plan(fast)).rejects.toThrow('codex exploded')

    const quitter = new FakeAgent('codex', [
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the point of the test
      () => Promise.reject('codex gave up'),
    ])
    await expect(
      new Planner([quitter, new FakeAgent('claude', [straggler()])], new FakeJev()).plan(fast),
    ).rejects.toThrow('codex gave up')
  })

  it('ignores an answer that arrives after a draft was accepted', async () => {
    // Answers late and ignores the abort.
    const codex = new FakeAgent('codex', [late('codex draft')])
    const claude = new FakeAgent('claude', ['claude draft'])

    const result = await new Planner([codex, claude], new FakeJev([accept])).plan(fast)
    await new Promise((resolve) => setTimeout(resolve, 30))

    expect(result.drafts).toEqual({ claude: 'claude draft' })
    expect(result.timings.rounds[0]?.agents).not.toHaveProperty('codex')
  })

  it('rejects the debate review and claim checks before any agent call', async () => {
    const codex = new FakeAgent('codex', ['codex draft'])
    const claude = new FakeAgent('claude', ['claude draft'])
    const planner = new Planner([codex, claude], new FakeJev())

    await expect(planner.plan({ ...fast, reviewMode: 'debate' })).rejects.toThrow(
      'The debate review is a review round, and fast mode has none',
    )
    await expect(planner.plan({ ...fast, claimChecks: true })).rejects.toThrow(
      'The debate review is a review round, and fast mode has none',
    )
    expect(codex.prompts).toEqual([])
  })
})
