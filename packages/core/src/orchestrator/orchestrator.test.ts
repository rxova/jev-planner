import { describe, expect, it } from 'vitest'
import { Planner } from './orchestrator.js'
import { TaskValidationError } from '../task/task.js'
import { verdict, late, FakeAgent, FakeJev, task } from './orchestrator.fixtures.js'
import type { PlanRound } from './orchestrator.types.js'

describe('Planner in balanced mode', () => {
  it('judges the drafts and skips a cross-review Jev does not ask for', async () => {
    const codex = new FakeAgent('codex', ['codex draft'])
    const claude = new FakeAgent('claude', ['claude draft', 'final plan'])
    const jev = new FakeJev()

    const result = await new Planner([codex, claude], jev).plan(task)

    expect(result.plan).toBe('final plan')
    expect(result.finalizer).toBe('claude')
    expect(jev.input).toMatchObject({
      stage: 'draft',
      plans: [
        { agent: 'codex', label: 'Codex', plan: 'codex draft' },
        { agent: 'claude', label: 'Claude', plan: 'claude draft' },
      ],
    })
    // The drafts never met until the merge, so the merge saw both.
    expect(claude.prompts[1]).toContain('codex draft')
    expect(claude.prompts[1]).toContain('claude draft')
    expect(result.cost).toEqual({
      mode: 'balanced',
      reviewMode: 'standard',
      reviewRounds: 0,
      synthesized: true,
      agentCalls: 3,
      judgeCalls: 1,
      dropped: [],
    })
  })

  it('cross-reviews when Jev asks, and aims the revision with the draft verdict', async () => {
    const codex = new FakeAgent('codex', ['codex draft', 'codex revised'])
    const claude = new FakeAgent('claude', ['claude draft', 'claude revised', 'final plan'])
    const jev = new FakeJev([{ needsAnotherPassProbability: 0.9 }, {}])
    const stages: string[] = []

    const result = await new Planner([codex, claude], jev).plan({
      ...task,
      onStage: (message) => stages.push(message),
    })

    expect(result.plan).toBe('final plan')
    expect(codex.prompts[1]).toContain('The judge identified remaining uncertainty')
    expect(codex.prompts[1]).toContain('claude draft')
    expect(jev.inputs.map(({ stage }) => stage)).toEqual(['draft', 'review'])
    expect(stages).toEqual([
      'Drafting independent plans with Codex and Claude…',
      'Asking Jev for typed quality and routing decisions…',
      'Cross-reviewing the 2 drafts…',
      'Re-evaluating the revised plans with Jev…',
      'Synthesizing the final plan with Claude…',
    ])
    expect(result.cost).toMatchObject({ reviewRounds: 1, agentCalls: 5, judgeCalls: 2 })
  })

  it('reports the draft round with the verdict Jev gave it', async () => {
    const codex = new FakeAgent('codex', ['codex draft'])
    const claude = new FakeAgent('claude', ['claude draft', 'final plan'])
    const rounds: PlanRound[] = []

    await new Planner([codex, claude], new FakeJev()).plan({
      ...task,
      onRound: (round) => {
        rounds.push(round)
      },
    })

    expect(rounds).toEqual([
      {
        round: 1,
        stage: 'draft',
        plans: { codex: 'codex draft', claude: 'claude draft' },
        verdict,
        timings: expect.objectContaining({
          agents: expect.any(Object),
          judgeMs: expect.any(Number),
        }),
      },
      {
        round: 2,
        stage: 'final',
        plans: { claude: 'final plan' },
        verdict,
        timings: expect.objectContaining({ agents: expect.any(Object) }),
      },
    ])
  })
})

describe('Planner in ultra mode', () => {
  const ultra = { ...task, mode: 'ultra' } as const

  it("drafts, cross-reviews, asks Jev, and uses Jev's finalizer", async () => {
    const codex = new FakeAgent('codex', ['codex draft', 'codex revised'])
    const claude = new FakeAgent('claude', ['claude draft', 'claude revised', 'final plan'])
    // Even told a plan stands alone, ultra buys the merge it promises.
    const jev = new FakeJev([{ standsAloneProbability: 0.99, strongerPlan: 'codex' }])

    const result = await new Planner([codex, claude], jev).plan(ultra)

    expect(result.plan).toBe('final plan')
    expect(result.finalizer).toBe('claude')
    expect(jev.input).toMatchObject({
      task: 'Add caching',
      stage: 'review',
      plans: [
        { agent: 'codex', label: 'Codex', plan: 'codex revised' },
        { agent: 'claude', label: 'Claude', plan: 'claude revised' },
      ],
    })
    expect(result.drafts).toEqual({ codex: 'codex revised', claude: 'claude revised' })
    expect(result.cost).toEqual({
      mode: 'ultra',
      reviewMode: 'standard',
      reviewRounds: 1,
      synthesized: true,
      agentCalls: 5,
      judgeCalls: 1,
      dropped: [],
    })
    expect(codex.prompts).toHaveLength(2)
    expect(claude.prompts).toHaveLength(3)
    expect(codex.prompts[1]).toContain('claude draft')
    expect(claude.prompts[1]).toContain('codex draft')
    expect(claude.prompts[2]).toContain('jev-test')
  })

  it('honors an explicit finalizer override', async () => {
    const codex = new FakeAgent('codex', ['codex draft', 'codex revised', 'codex final'])
    const claude = new FakeAgent('claude', ['claude draft', 'claude revised'])

    const result = await new Planner([codex, claude], new FakeJev()).plan({
      ...ultra,
      finalizer: 'codex',
    })

    expect(result.plan).toBe('codex final')
    expect(result.finalizer).toBe('codex')
  })

  it('runs one extra review when Jev requests it', async () => {
    const codex = new FakeAgent('codex', [
      'codex draft',
      'codex revised',
      'codex refined',
      'codex final',
    ])
    const claude = new FakeAgent('claude', ['claude draft', 'claude revised', 'claude refined'])
    const jev = new FakeJev([
      { finalizer: 'codex', needsAnotherPassProbability: 0.9 },
      { finalizer: 'codex', needsAnotherPassProbability: 0.1 },
    ])

    const result = await new Planner([codex, claude], jev).plan(ultra)

    expect(result.plan).toBe('codex final')
    expect(codex.prompts).toHaveLength(4)
    expect(claude.prompts).toHaveLength(3)
    expect(codex.prompts[2]).toContain('The judge identified remaining uncertainty')
    expect(result.cost).toMatchObject({ reviewRounds: 2, judgeCalls: 2, agentCalls: 7 })
  })

  it('waits for every agent, however long one takes', async () => {
    const codex = new FakeAgent('codex', [late('codex draft'), 'codex revised'])
    const claude = new FakeAgent('claude', ['claude draft', 'claude revised', 'final plan'])

    const result = await new Planner([codex, claude], new FakeJev()).plan(ultra)

    expect(result.cost.dropped).toEqual([])
    expect(result.drafts).toMatchObject({ codex: 'codex revised' })
  })

  it('passes a Jev model override and reports each stage', async () => {
    const codex = new FakeAgent('codex', ['codex draft', 'codex revised'])
    const claude = new FakeAgent('claude', ['claude draft', 'claude revised', 'final plan'])
    const jev = new FakeJev()
    const stages: string[] = []

    await new Planner([codex, claude], jev).plan({
      ...ultra,
      judgeModel: 'jev-custom',
      onStage: (message) => stages.push(message),
    })

    expect(jev.input?.model).toBe('jev-custom')
    expect(stages).toEqual([
      'Drafting independent plans with Codex and Claude…',
      'Cross-reviewing the 2 drafts…',
      'Asking Jev for typed quality and routing decisions…',
      'Synthesizing the final plan with Claude…',
    ])
  })

  it('skips the extra review when limited to one round, and passes the model on a re-judge', async () => {
    const run = async (maxReviewRounds: 1 | 2) => {
      const codex = new FakeAgent('codex', ['d', 'r', 'refined', 'final'])
      const claude = new FakeAgent('claude', ['d', 'r', 'refined'])
      const jev = new FakeJev([{ finalizer: 'codex', needsAnotherPassProbability: 0.9 }])
      await new Planner([codex, claude], jev).plan({
        ...ultra,
        maxReviewRounds,
        judgeModel: 'jev-custom',
      })
      return jev.inputs.map(({ model }) => model)
    }

    await expect(run(1)).resolves.toEqual(['jev-custom'])
    await expect(run(2)).resolves.toEqual(['jev-custom', 'jev-custom'])
  })

  it('drafts and merges with no cross-review at all when none is allowed', async () => {
    const codex = new FakeAgent('codex', ['codex draft'])
    const claude = new FakeAgent('claude', ['claude draft', 'final plan'])
    const jev = new FakeJev([{ needsAnotherPassProbability: 0.9 }])

    const result = await new Planner([codex, claude], jev).plan({ ...ultra, maxReviewRounds: 0 })

    expect(result.plan).toBe('final plan')
    expect(jev.input?.stage).toBe('draft')
    expect(result.cost).toMatchObject({ reviewRounds: 0, agentCalls: 3, judgeCalls: 1 })
  })

  it('runs any number of agents, each revising against every peer', async () => {
    const codex = new FakeAgent('codex', ['codex draft', 'codex revised'])
    const claude = new FakeAgent('claude', ['claude draft', 'claude revised'])
    const glm = new FakeAgent('glm', ['glm draft', 'glm revised', 'glm final'])
    const jev = new FakeJev([{ finalizer: 'glm' }])
    const stages: string[] = []

    const result = await new Planner([codex, claude, glm], jev).plan({
      ...ultra,
      onStage: (message) => stages.push(message),
    })

    expect(result).toMatchObject({ plan: 'glm final', finalizer: 'glm' })
    expect(result.drafts).toEqual({
      codex: 'codex revised',
      claude: 'claude revised',
      glm: 'glm revised',
    })
    expect(stages[0]).toBe('Drafting independent plans with Codex, Claude and Glm…')
    expect(codex.prompts[0]).toContain('in a collaboration with Claude and Glm.')
    expect(codex.prompts[1]).toContain('<peer-plan author="Claude">\nclaude draft\n</peer-plan>')
    expect(codex.prompts[1]).toContain('<peer-plan author="Glm">\nglm draft\n</peer-plan>')
    expect(codex.prompts[1]).not.toContain('<peer-plan author="Codex">')
    expect(glm.prompts[2]).toContain(
      '<revised-plan author="Claude">\nclaude revised\n</revised-plan>',
    )
  })

  it('reports every round as it ends, and waits for each report', async () => {
    const codex = new FakeAgent('codex', ['codex draft', 'codex revised', 'codex refined'])
    const claude = new FakeAgent('claude', [
      'claude draft',
      'claude revised',
      'claude refined',
      'final plan',
    ])
    const jev = new FakeJev([{ needsAnotherPassProbability: 0.9 }, { ...verdict }])
    const rounds: PlanRound[] = []
    const events: string[] = []

    await new Planner([codex, claude], jev).plan({
      ...ultra,
      onStage: (message) => events.push(message),
      onRound: async (round) => {
        await Promise.resolve()
        rounds.push(round)
        events.push(`round ${String(round.round)}`)
      },
    })

    const timed = (agents: string[], judged: boolean) => ({
      totalMs: expect.any(Number) as number,
      agents: Object.fromEntries(agents.map((agent) => [agent, expect.any(Number) as number])),
      ...(judged ? { judgeMs: expect.any(Number) as number } : {}),
    })
    expect(rounds).toEqual([
      {
        round: 1,
        stage: 'draft',
        plans: { codex: 'codex draft', claude: 'claude draft' },
        timings: timed(['codex', 'claude'], false),
      },
      {
        round: 2,
        stage: 'review',
        plans: { codex: 'codex revised', claude: 'claude revised' },
        verdict: { ...verdict, needsAnotherPassProbability: 0.9 },
        timings: timed(['codex', 'claude'], true),
      },
      {
        round: 3,
        stage: 'review',
        plans: { codex: 'codex refined', claude: 'claude refined' },
        verdict,
        timings: timed(['codex', 'claude'], true),
      },
      {
        round: 4,
        stage: 'final',
        plans: { claude: 'final plan' },
        verdict,
        timings: timed(['claude'], false),
      },
    ])
    expect(events.indexOf('round 1')).toBeLessThan(events.indexOf('Cross-reviewing the 2 drafts…'))
  })
})

describe('Planner', () => {
  it('rejects a placeholder task before any agent or Jev call', async () => {
    const codex = new FakeAgent('codex', ['codex draft'])
    const claude = new FakeAgent('claude', ['claude draft'])
    const jev = new FakeJev()

    await expect(
      new Planner([codex, claude], jev).plan({
        ...task,
        task: 'Describe the coding change you want to plan',
      }),
    ).rejects.toThrow(TaskValidationError)
    expect(codex.prompts).toEqual([])
    expect(claude.prompts).toEqual([])
    expect(jev.input).toBeUndefined()
  })

  it('plans a placeholder task when allowAnyTask is set', async () => {
    const codex = new FakeAgent('codex', ['codex draft'])
    const claude = new FakeAgent('claude', ['claude draft', 'final plan'])

    const result = await new Planner([codex, claude], new FakeJev()).plan({
      ...task,
      task: 'TODO',
      allowAnyTask: true,
    })

    expect(result.plan).toBe('final plan')
    expect(codex.prompts[0]).toContain('<task>\nTODO\n</task>')
  })

  it('needs at least two agents with distinct names', () => {
    const jev = new FakeJev()
    expect(() => new Planner([new FakeAgent('codex', [])], jev)).toThrow(
      'A planner needs at least two agents',
    )
    expect(
      () => new Planner([new FakeAgent('codex', []), new FakeAgent('codex', [])], jev),
    ).toThrow('Agent "codex" is listed more than once')
  })

  it('rejects a finalizer override that is not one of its agents, before any call', async () => {
    const codex = new FakeAgent('codex', [])
    const planner = new Planner([codex, new FakeAgent('claude', [])], new FakeJev())
    await expect(planner.plan({ ...task, finalizer: 'glm' })).rejects.toThrow(
      '"glm" is not one of this planner\'s agents: codex, claude',
    )
    expect(codex.prompts).toEqual([])
  })

  it("rejects Jev's pick when it names no agent", async () => {
    const codex = new FakeAgent('codex', ['d'])
    const claude = new FakeAgent('claude', ['d'])
    const jev = new FakeJev([{ finalizer: 'nobody' }])
    await expect(new Planner([codex, claude], jev).plan(task)).rejects.toThrow(
      '"nobody" is not one of',
    )
  })
})
