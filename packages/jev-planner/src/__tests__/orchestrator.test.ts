import { afterEach, describe, expect, it, vi } from 'vitest'
import { Planner } from '../orchestrator.js'
import { TaskValidationError } from '../task.js'
import type { AgentRequest, JevJudge, JevVerdict, PlanRound, PlanningAgent } from '../types.js'

const verdict: JevVerdict = {
  strongerPlan: 'tie',
  strongerPlanConfidence: 0.2,
  finalizer: 'claude',
  finalizerConfidence: 0.8,
  completeness: 2.8,
  completenessConfidence: 0.9,
  feasibility: 2.9,
  feasibilityConfidence: 0.9,
  riskCoverage: 2.7,
  riskCoverageConfidence: 0.8,
  needsAnotherPassProbability: 0.1,
  standsAloneProbability: 0.1,
  model: 'jev-test',
}

/** An answer that takes its time, or never comes; the argument is the live request. */
type Answer = (request: AgentRequest) => Promise<string>

/** Never answers, and reports the abort when the round stops waiting for it. */
const straggler =
  (aborts: string[] = []): Answer =>
  (request) =>
    new Promise<string>((_resolve, reject) => {
      request.signal?.addEventListener('abort', () => {
        aborts.push('aborted')
        reject(new Error('stopped'))
      })
    })

/** Answers, but only after the grace window has long passed. */
const late =
  (plan: string): Answer =>
  () =>
    new Promise<string>((resolve) => setTimeout(() => resolve(plan), 20))

class FakeAgent implements PlanningAgent {
  readonly prompts: string[] = []
  readonly requests: AgentRequest[] = []

  readonly label: string

  constructor(
    readonly name: string,
    private readonly responses: (string | Answer)[],
  ) {
    this.label = `${name.charAt(0).toUpperCase()}${name.slice(1)}`
  }

  async generate(request: AgentRequest): Promise<string> {
    this.prompts.push(request.prompt)
    this.requests.push(request)
    request.onProgress?.(`working on call ${String(this.prompts.length)}`)
    const response = this.responses.shift()
    if (!response) throw new Error(`No fake ${this.name} response`)
    return typeof response === 'string' ? response : response(request)
  }
}

class FakeJev implements JevJudge {
  readonly inputs: Parameters<JevJudge['judge']>[0][] = []

  constructor(private readonly verdicts: Partial<JevVerdict>[] = [{}]) {}

  get input(): Parameters<JevJudge['judge']>[0] | undefined {
    return this.inputs.at(-1)
  }

  async judge(input: Parameters<JevJudge['judge']>[0]): Promise<JevVerdict> {
    this.inputs.push(input)
    return { ...verdict, ...(this.verdicts.at(this.inputs.length - 1) ?? this.verdicts.at(-1)) }
  }
}

const task = { task: 'Add caching', cwd: '/tmp', timeoutMs: 1_000 } as const

describe('Planner in fast mode', () => {
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
      mode: 'fast',
      reviewRounds: 0,
      synthesized: true,
      agentCalls: 3,
      jevCalls: 1,
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
    expect(codex.prompts[1]).toContain('Jev identified remaining uncertainty')
    expect(codex.prompts[1]).toContain('claude draft')
    expect(jev.inputs.map(({ stage }) => stage)).toEqual(['draft', 'review'])
    expect(stages).toEqual([
      'Drafting independent plans with Codex and Claude…',
      'Asking Jev for typed quality and routing decisions…',
      'Cross-reviewing the 2 drafts…',
      'Re-evaluating the revised plans with Jev…',
      'Synthesizing the final plan with Claude…',
    ])
    expect(result.cost).toMatchObject({ reviewRounds: 1, agentCalls: 5, jevCalls: 2 })
  })

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
        timings: expect.objectContaining({ agents: expect.any(Object), jevMs: expect.any(Number) }),
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

describe('Planner straggler grace', () => {
  it('stops waiting for a straggling reviewer and keeps its earlier plan', async () => {
    const aborts: string[] = []
    const codex = new FakeAgent('codex', ['codex draft', straggler(aborts)])
    const claude = new FakeAgent('claude', ['claude draft', 'claude revised', 'final plan'])
    const jev = new FakeJev([{ needsAnotherPassProbability: 0.9 }, {}])
    const stages: string[] = []

    const result = await new Planner([codex, claude], jev).plan({
      ...task,
      stragglerGraceMs: 1,
      onStage: (message) => stages.push(message),
    })

    expect(result.plan).toBe('final plan')
    expect(result.drafts).toEqual({ codex: 'codex draft', claude: 'claude revised' })
    expect(result.cost.dropped).toEqual(['codex'])
    expect(aborts).toEqual(['aborted'])
    expect(stages).toContain('Codex is still working; the round goes on without it…')
    expect(Object.keys(result.timings.rounds[1]?.agents ?? {})).toEqual(['claude'])
  })

  it('drops a straggling draft only while two plans are left', async () => {
    const codex = new FakeAgent('codex', ['codex draft'])
    const claude = new FakeAgent('claude', ['claude draft', 'final plan'])
    const glm = new FakeAgent('glm', [straggler()])
    const jev = new FakeJev([{ finalizer: 'claude' }])

    const result = await new Planner([codex, claude, glm], jev).plan({
      ...task,
      stragglerGraceMs: 1,
    })

    expect(result.cost.dropped).toEqual(['glm'])
    expect(jev.input?.plans.map(({ agent }) => agent)).toEqual(['codex', 'claude'])
    expect(result.drafts).toEqual({ codex: 'codex draft', claude: 'claude draft' })
  })

  it('waits for a draft no other plan can stand in for', async () => {
    const codex = new FakeAgent('codex', [late('codex draft')])
    const claude = new FakeAgent('claude', ['claude draft', 'final plan'])

    const result = await new Planner([codex, claude], new FakeJev()).plan({
      ...task,
      stragglerGraceMs: 1,
    })

    expect(result.cost.dropped).toEqual([])
    expect(result.drafts).toMatchObject({ codex: 'codex draft' })
  })

  it('ignores an answer that arrives after the round moved on', async () => {
    const codex = new FakeAgent('codex', ['codex draft'])
    const claude = new FakeAgent('claude', ['claude draft', 'final plan'])
    // Answers late and ignores the abort: the round has already gone without it.
    const glm = new FakeAgent('glm', [late('glm draft')])
    const jev = new FakeJev([{ finalizer: 'claude' }])

    const result = await new Planner([codex, claude, glm], jev).plan({
      ...task,
      stragglerGraceMs: 1,
    })

    expect(result.drafts).toEqual({ codex: 'codex draft', claude: 'claude draft' })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(result.drafts).toEqual({ codex: 'codex draft', claude: 'claude draft' })
    expect(result.timings.rounds[0]?.agents).not.toHaveProperty('glm')
  })

  it('waits for every agent when the grace is zero', async () => {
    const codex = new FakeAgent('codex', [late('codex draft')])
    const claude = new FakeAgent('claude', ['claude draft', 'final plan'])

    const result = await new Planner([codex, claude], new FakeJev()).plan({
      ...task,
      stragglerGraceMs: 0,
    })

    expect(result.cost.dropped).toEqual([])
    expect(result.drafts).toMatchObject({ codex: 'codex draft' })
  })

  it('fails the round when an agent it is still waiting for fails', async () => {
    const codex = new FakeAgent('codex', [() => Promise.reject(new Error('codex exploded'))])
    const claude = new FakeAgent('claude', ['claude draft'])

    await expect(
      new Planner([codex, claude], new FakeJev()).plan({ ...task, stragglerGraceMs: 1 }),
    ).rejects.toThrow('codex exploded')
  })

  it('reports a rejection that is not an Error', async () => {
    const codex = new FakeAgent('codex', [
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the point of the test
      () => Promise.reject('codex gave up'),
    ])
    const claude = new FakeAgent('claude', ['claude draft'])

    await expect(
      new Planner([codex, claude], new FakeJev()).plan({ ...task, stragglerGraceMs: 1 }),
    ).rejects.toThrow('codex gave up')
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
      reviewRounds: 1,
      synthesized: true,
      agentCalls: 5,
      jevCalls: 1,
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
    expect(codex.prompts[2]).toContain('Jev identified remaining uncertainty')
    expect(result.cost).toMatchObject({ reviewRounds: 2, jevCalls: 2, agentCalls: 7 })
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
      jevModel: 'jev-custom',
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
        jevModel: 'jev-custom',
      })
      return jev.inputs.map(({ model }) => model)
    }

    await expect(run(1)).resolves.toEqual(['jev-custom'])
    await expect(run(2)).resolves.toEqual(['jev-custom', 'jev-custom'])
  })

  describe('selectStronger', () => {
    const options = { ...ultra, selectStronger: true }

    it('returns the stronger revised plan as it is, with no synthesis call', async () => {
      const codex = new FakeAgent('codex', ['codex draft', 'codex revised'])
      const claude = new FakeAgent('claude', ['claude draft', 'claude revised'])
      const jev: JevJudge = { judge: async () => ({ ...verdict, strongerPlan: 'codex' }) }
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

  it('drafts and merges with no cross-review at all when none is allowed', async () => {
    const codex = new FakeAgent('codex', ['codex draft'])
    const claude = new FakeAgent('claude', ['claude draft', 'final plan'])
    const jev = new FakeJev([{ needsAnotherPassProbability: 0.9 }])

    const result = await new Planner([codex, claude], jev).plan({ ...ultra, maxReviewRounds: 0 })

    expect(result.plan).toBe('final plan')
    expect(jev.input?.stage).toBe('draft')
    expect(result.cost).toMatchObject({ reviewRounds: 0, agentCalls: 3, jevCalls: 1 })
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
      ...(judged ? { jevMs: expect.any(Number) as number } : {}),
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

  it("tags each agent's progress with its name, in every call, the final one included", async () => {
    const codex = new FakeAgent('codex', ['codex draft'])
    const claude = new FakeAgent('claude', ['claude draft', 'final plan'])
    const progress: string[] = []
    await new Planner([codex, claude], new FakeJev()).plan({
      ...task,
      onAgentProgress: (agent, line) => progress.push(`${agent}: ${line}`),
    })
    expect(progress.sort()).toEqual([
      'claude: working on call 1',
      'claude: working on call 2',
      'codex: working on call 1',
    ])
  })

  it('asks for no progress when nobody listens', async () => {
    const codex = new FakeAgent('codex', ['codex draft'])
    const claude = new FakeAgent('claude', ['claude draft', 'final plan'])
    await new Planner([codex, claude], new FakeJev()).plan(task)
    for (const request of [...codex.requests, ...claude.requests]) {
      expect(request.onProgress).toBeUndefined()
    }
  })

  it('stops the run when a round report fails', async () => {
    const codex = new FakeAgent('codex', ['codex draft'])
    const claude = new FakeAgent('claude', ['claude draft'])
    const planner = new Planner([codex, claude], new FakeJev())
    await expect(
      planner.plan({ ...task, onRound: () => Promise.reject(new Error('disk full')) }),
    ).rejects.toThrow('disk full')
    expect(codex.prompts).toHaveLength(1)
  })

  describe('sessions', () => {
    const run = (planner: Planner, resume?: boolean) =>
      planner.plan({
        task: 'Add caching',
        cwd: '/tmp',
        timeoutMs: 1_000,
        mode: 'ultra',
        ...(resume === undefined ? {} : { resume }),
      })

    it('gives each agent one session for every call in a run, and a new one each run', async () => {
      const codex = new FakeAgent('codex', ['d', 'r', 'd', 'r'])
      const claude = new FakeAgent('claude', ['d', 'r', 'final', 'd', 'r', 'final'])
      const planner = new Planner([codex, claude], new FakeJev())
      await run(planner)
      await run(planner)

      const sessionsOf = (agent: FakeAgent) => agent.requests.map(({ session }) => session)
      const [first, , , second] = sessionsOf(claude)
      expect(first).toBeDefined()
      expect(sessionsOf(claude)).toEqual([first, first, first, second, second, second])
      expect(second).not.toBe(first)
      expect(sessionsOf(codex)[0]).not.toBe(first)
      expect(sessionsOf(codex)[0]).toBe(sessionsOf(codex)[1])
    })

    it('gives a draft only the whole prompt, and later calls a shorter one to resume with', async () => {
      const codex = new FakeAgent('codex', ['codex draft', 'codex revised'])
      const claude = new FakeAgent('claude', ['claude draft', 'claude revised', 'final plan'])
      await run(new Planner([codex, claude], new FakeJev()))

      const [draft, revision, final] = claude.requests
      expect(draft).not.toHaveProperty('resumePrompt')
      expect(revision?.prompt).toContain('<own-plan>\nclaude draft\n</own-plan>')
      expect(revision?.resumePrompt).not.toContain('<own-plan>')
      expect(revision?.resumePrompt).not.toContain('<task>')
      expect(revision?.resumePrompt).toContain('codex draft')
      expect(final?.prompt).toContain('<task>\nAdd caching\n</task>')
      expect(final?.resumePrompt).not.toContain('<task>')
      expect(final?.resumePrompt).toContain('codex revised')
    })

    it('passes no session and no resume prompt with resume off', async () => {
      const codex = new FakeAgent('codex', ['codex draft', 'codex revised'])
      const claude = new FakeAgent('claude', ['claude draft', 'claude revised', 'final plan'])
      await run(new Planner([codex, claude], new FakeJev()), false)
      for (const request of [...codex.requests, ...claude.requests]) {
        expect(request).not.toHaveProperty('session')
        expect(request).not.toHaveProperty('resumePrompt')
      }
    })
  })

  it('asks for the review effort in the cross-reviews and the synthesis, not the drafts', async () => {
    const codex = new FakeAgent('codex', ['codex draft', 'codex revised'])
    const claude = new FakeAgent('claude', ['claude draft', 'claude revised', 'final plan'])
    await new Planner([codex, claude], new FakeJev()).plan({
      task: 'Add caching',
      cwd: '/tmp',
      timeoutMs: 1_000,
      mode: 'ultra',
      reviewEfforts: { claude: 'low' },
    })
    expect(claude.requests.map(({ effort }) => effort)).toEqual([undefined, 'low', 'low'])
    for (const request of [...codex.requests, claude.requests[0]]) {
      expect(request).not.toHaveProperty('effort')
    }
  })

  describe('timings', () => {
    afterEach(() => {
      vi.useRealTimers()
    })

    /** Answers after `ms` of fake time, one delay per call. */
    const slow = (name: string, calls: [string, number][]): PlanningAgent => ({
      name,
      label: name,
      generate: async () => {
        const [plan, ms] = calls.shift() ?? ['', 0]
        await new Promise((done) => setTimeout(done, ms))
        return plan
      },
    })

    it('times each round, each agent call and each Jev call, and the whole run', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'performance'] })
      const codex = slow('codex', [
        ['codex draft', 5_000],
        ['codex revised', 2_000],
        ['final', 1_500],
      ])
      const claude = slow('claude', [
        ['claude draft', 3_000],
        ['claude revised', 2_500],
      ])
      const jev: JevJudge = {
        judge: async () => {
          await new Promise((done) => setTimeout(done, 400))
          return { ...verdict, finalizer: 'codex' }
        },
      }
      const onRound = vi.fn<(round: PlanRound) => Promise<void>>(async () => {
        // Time spent reporting a round is counted in no round.
        await new Promise((done) => setTimeout(done, 10_000))
      })
      const running = new Planner([codex, claude], jev).plan({
        task: 'Add caching',
        cwd: '/tmp',
        timeoutMs: 1_000,
        mode: 'ultra',
        onRound,
      })
      await vi.runAllTimersAsync()
      const { timings } = await running

      expect(onRound.mock.calls.map(([round]) => round.timings)).toEqual([
        { totalMs: 5_000, agents: { codex: 5_000, claude: 3_000 } },
        { totalMs: 2_900, agents: { codex: 2_000, claude: 2_500 }, jevMs: 400 },
        { totalMs: 1_500, agents: { codex: 1_500 } },
      ])
      expect(timings).toEqual({
        totalMs: 5_000 + 2_900 + 1_500 + 3 * 10_000,
        rounds: [
          { round: 1, stage: 'draft', totalMs: 5_000, agents: { codex: 5_000, claude: 3_000 } },
          {
            round: 2,
            stage: 'review',
            totalMs: 2_900,
            agents: { codex: 2_000, claude: 2_500 },
            jevMs: 400,
          },
          { round: 3, stage: 'final', totalMs: 1_500, agents: { codex: 1_500 } },
        ],
      })
    })

    it('counts Jev judging the drafts in the draft round, in fast mode', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'performance'] })
      const codex = slow('codex', [
        ['codex draft', 5_000],
        ['final', 1_500],
      ])
      const claude = slow('claude', [['claude draft', 3_000]])
      const jev: JevJudge = {
        judge: async () => {
          await new Promise((done) => setTimeout(done, 400))
          return { ...verdict, finalizer: 'codex' }
        },
      }
      const running = new Planner([codex, claude], jev).plan({
        task: 'Add caching',
        cwd: '/tmp',
        timeoutMs: 1_000,
      })
      await vi.runAllTimersAsync()
      const { timings } = await running

      expect(timings).toEqual({
        totalMs: 5_400 + 1_500,
        rounds: [
          {
            round: 1,
            stage: 'draft',
            totalMs: 5_400,
            agents: { codex: 5_000, claude: 3_000 },
            jevMs: 400,
          },
          { round: 2, stage: 'final', totalMs: 1_500, agents: { codex: 1_500 } },
        ],
      })
    })
  })
})
