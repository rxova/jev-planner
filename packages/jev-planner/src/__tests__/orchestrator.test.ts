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
  model: 'jev-test',
}

class FakeAgent implements PlanningAgent {
  readonly prompts: string[] = []
  readonly requests: AgentRequest[] = []

  readonly label: string

  constructor(
    readonly name: string,
    private readonly responses: string[],
  ) {
    this.label = `${name.charAt(0).toUpperCase()}${name.slice(1)}`
  }

  async generate(request: AgentRequest): Promise<string> {
    this.prompts.push(request.prompt)
    this.requests.push(request)
    request.onProgress?.(`working on call ${String(this.prompts.length)}`)
    const response = this.responses.shift()
    if (!response) throw new Error(`No fake ${this.name} response`)
    return response
  }
}

class FakeJev implements JevJudge {
  input: Parameters<JevJudge['judge']>[0] | undefined

  async judge(input: Parameters<JevJudge['judge']>[0]): Promise<JevVerdict> {
    this.input = input
    return verdict
  }
}

describe('Planner', () => {
  it("drafts, cross-reviews, asks Jev, and uses Jev's finalizer", async () => {
    const codex = new FakeAgent('codex', ['codex draft', 'codex revised'])
    const claude = new FakeAgent('claude', ['claude draft', 'claude revised', 'final plan'])
    const jev = new FakeJev()
    const planner = new Planner([codex, claude], jev)

    const result = await planner.plan({
      task: 'Add caching',
      cwd: '/tmp',
      timeoutMs: 1_000,
    })

    expect(result.plan).toBe('final plan')
    expect(result.finalizer).toBe('claude')
    expect(jev.input).toMatchObject({
      task: 'Add caching',
      plans: [
        { agent: 'codex', label: 'Codex', plan: 'codex revised' },
        { agent: 'claude', label: 'Claude', plan: 'claude revised' },
      ],
    })
    expect(result.drafts).toEqual({ codex: 'codex revised', claude: 'claude revised' })
    expect(codex.prompts).toHaveLength(2)
    expect(claude.prompts).toHaveLength(3)
    expect(codex.prompts[1]).toContain('claude draft')
    expect(claude.prompts[1]).toContain('codex draft')
    expect(claude.prompts[2]).toContain('jev-test')
  })

  it('honors an explicit finalizer override', async () => {
    const codex = new FakeAgent('codex', ['codex draft', 'codex revised', 'codex final'])
    const claude = new FakeAgent('claude', ['claude draft', 'claude revised'])
    const planner = new Planner([codex, claude], new FakeJev())

    const result = await planner.plan({
      task: 'Add caching',
      cwd: '/tmp',
      timeoutMs: 1_000,
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
    let call = 0
    const jev: JevJudge = {
      judge: async () => ({
        ...verdict,
        finalizer: 'codex',
        needsAnotherPassProbability: call++ === 0 ? 0.9 : 0.1,
      }),
    }

    const result = await new Planner([codex, claude], jev).plan({
      task: 'Add caching',
      cwd: '/tmp',
      timeoutMs: 1_000,
    })

    expect(result.plan).toBe('codex final')
    expect(codex.prompts).toHaveLength(4)
    expect(claude.prompts).toHaveLength(3)
    expect(codex.prompts[2]).toContain('Jev identified remaining uncertainty')
    expect(call).toBe(2)
  })

  it('passes a Jev model override and reports each stage', async () => {
    const codex = new FakeAgent('codex', ['codex draft', 'codex revised'])
    const claude = new FakeAgent('claude', ['claude draft', 'claude revised', 'final plan'])
    const jev = new FakeJev()
    const stages: string[] = []

    await new Planner([codex, claude], jev).plan({
      task: 'Add caching',
      cwd: '/tmp',
      timeoutMs: 1_000,
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
      const models: (string | undefined)[] = []
      const jev: JevJudge = {
        judge: async (input) => {
          models.push(input.model)
          return { ...verdict, finalizer: 'codex', needsAnotherPassProbability: 0.9 }
        },
      }
      await new Planner([codex, claude], jev).plan({
        task: 'Add caching',
        cwd: '/tmp',
        timeoutMs: 1_000,
        maxReviewRounds,
        jevModel: 'jev-custom',
      })
      return models
    }

    await expect(run(1)).resolves.toEqual(['jev-custom'])
    await expect(run(2)).resolves.toEqual(['jev-custom', 'jev-custom'])
  })

  it('rejects a placeholder task before any agent or Jev call', async () => {
    const codex = new FakeAgent('codex', ['codex draft'])
    const claude = new FakeAgent('claude', ['claude draft'])
    const jev = new FakeJev()
    const planner = new Planner([codex, claude], jev)

    await expect(
      planner.plan({
        task: 'Describe the coding change you want to plan',
        cwd: '/tmp',
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow(TaskValidationError)
    expect(codex.prompts).toEqual([])
    expect(claude.prompts).toEqual([])
    expect(jev.input).toBeUndefined()
  })

  it('plans a placeholder task when allowAnyTask is set', async () => {
    const codex = new FakeAgent('codex', ['codex draft', 'codex revised'])
    const claude = new FakeAgent('claude', ['claude draft', 'claude revised', 'final plan'])
    const planner = new Planner([codex, claude], new FakeJev())

    const result = await planner.plan({
      task: 'TODO',
      cwd: '/tmp',
      timeoutMs: 1_000,
      allowAnyTask: true,
    })
    expect(result.plan).toBe('final plan')
    expect(codex.prompts[0]).toContain('<task>\nTODO\n</task>')
  })

  it('runs any number of agents, each revising against every peer', async () => {
    const codex = new FakeAgent('codex', ['codex draft', 'codex revised'])
    const claude = new FakeAgent('claude', ['claude draft', 'claude revised'])
    const glm = new FakeAgent('glm', ['glm draft', 'glm revised', 'glm final'])
    const jev: JevJudge = { judge: async () => ({ ...verdict, finalizer: 'glm' }) }
    const stages: string[] = []

    const result = await new Planner([codex, claude, glm], jev).plan({
      task: 'Add caching',
      cwd: '/tmp',
      timeoutMs: 1_000,
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
    await expect(
      planner.plan({ task: 'Add caching', cwd: '/tmp', timeoutMs: 1_000, finalizer: 'glm' }),
    ).rejects.toThrow('"glm" is not one of this planner\'s agents: codex, claude')
    expect(codex.prompts).toEqual([])
  })

  it("rejects Jev's pick when it names no agent", async () => {
    const codex = new FakeAgent('codex', ['d', 'r'])
    const claude = new FakeAgent('claude', ['d', 'r'])
    const jev: JevJudge = { judge: async () => ({ ...verdict, finalizer: 'nobody' }) }
    await expect(
      new Planner([codex, claude], jev).plan({
        task: 'Add caching',
        cwd: '/tmp',
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow('"nobody" is not one of')
  })

  it('reports every round as it ends, and waits for each report', async () => {
    const codex = new FakeAgent('codex', ['codex draft', 'codex revised', 'codex refined'])
    const claude = new FakeAgent('claude', [
      'claude draft',
      'claude revised',
      'claude refined',
      'final plan',
    ])
    const verdicts = [
      { ...verdict, needsAnotherPassProbability: 0.9 },
      { ...verdict, needsAnotherPassProbability: 0.1 },
    ]
    const jev: JevJudge = { judge: async () => verdicts.shift() ?? verdict }
    const rounds: PlanRound[] = []
    const events: string[] = []

    await new Planner([codex, claude], jev).plan({
      task: 'Add caching',
      cwd: '/tmp',
      timeoutMs: 1_000,
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

  it("tags each agent's progress with its name, in every call, the final one included", async () => {
    const codex = new FakeAgent('codex', ['codex draft', 'codex revised'])
    const claude = new FakeAgent('claude', ['claude draft', 'claude revised', 'final plan'])
    const progress: string[] = []
    await new Planner([codex, claude], new FakeJev()).plan({
      task: 'Add caching',
      cwd: '/tmp',
      timeoutMs: 1_000,
      onAgentProgress: (agent, line) => progress.push(`${agent}: ${line}`),
    })
    expect(progress.sort()).toEqual([
      'claude: working on call 1',
      'claude: working on call 2',
      'claude: working on call 3',
      'codex: working on call 1',
      'codex: working on call 2',
    ])
  })

  it('asks for no progress when nobody listens', async () => {
    const codex = new FakeAgent('codex', ['codex draft', 'codex revised'])
    const claude = new FakeAgent('claude', ['claude draft', 'claude revised', 'final plan'])
    await new Planner([codex, claude], new FakeJev()).plan({
      task: 'Add caching',
      cwd: '/tmp',
      timeoutMs: 1_000,
    })
    for (const request of [...codex.requests, ...claude.requests]) {
      expect(request.onProgress).toBeUndefined()
    }
  })

  it('stops the run when a round report fails', async () => {
    const codex = new FakeAgent('codex', ['codex draft'])
    const claude = new FakeAgent('claude', ['claude draft'])
    const planner = new Planner([codex, claude], new FakeJev())
    await expect(
      planner.plan({
        task: 'Add caching',
        cwd: '/tmp',
        timeoutMs: 1_000,
        onRound: () => Promise.reject(new Error('disk full')),
      }),
    ).rejects.toThrow('disk full')
    expect(codex.prompts).toHaveLength(1)
  })

  describe('sessions', () => {
    const run = (planner: Planner, resume?: boolean) =>
      planner.plan({
        task: 'Add caching',
        cwd: '/tmp',
        timeoutMs: 1_000,
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
  })
})
