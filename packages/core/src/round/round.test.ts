import { describe, expect, it } from 'vitest'
import { Planner } from '../orchestrator/orchestrator.js'
import { straggler, late, FakeAgent, FakeJev, task } from '../orchestrator/orchestrator.fixtures.js'

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
