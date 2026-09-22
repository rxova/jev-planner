import { afterEach, describe, expect, it, vi } from 'vitest'
import { Planner } from '../orchestrator/orchestrator.js'
import { verdict, FakeAgent, FakeJev, task } from '../orchestrator/orchestrator.fixtures.js'
import type { PlanningAgent } from '../provider/provider.types.js'
import type { PlanJudge } from '../questions/questions.types.js'
import type { PlanRound } from '../orchestrator/orchestrator.types.js'

describe('Planner run state', () => {
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
      const jev: PlanJudge = {
        name: 'Jev',
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
        { totalMs: 2_900, agents: { codex: 2_000, claude: 2_500 }, judgeMs: 400 },
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
            judgeMs: 400,
          },
          { round: 3, stage: 'final', totalMs: 1_500, agents: { codex: 1_500 } },
        ],
      })
    })

    it('counts Jev judging the drafts in the draft round, in balanced mode', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'performance'] })
      const codex = slow('codex', [
        ['codex draft', 5_000],
        ['final', 1_500],
      ])
      const claude = slow('claude', [['claude draft', 3_000]])
      const jev: PlanJudge = {
        name: 'Jev',
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
            judgeMs: 400,
          },
          { round: 2, stage: 'final', totalMs: 1_500, agents: { codex: 1_500 } },
        ],
      })
    })
  })
})
