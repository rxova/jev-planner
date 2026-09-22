import { beforeEach, describe, expect, it, vi } from 'vitest'
import { GraphJevJudge } from '../graph-jev.js'
import { TypeSafeJevJudge } from '../jev.js'
import { createJevJudge, judgePanel, panelProviders } from '../judge-models.js'
import type { Provider } from '../provider.js'
import type { JevVerdict } from '../types.js'

vi.mock('../jev.js', () => ({ TypeSafeJevJudge: vi.fn() }))

const TypeSafe = vi.mocked(TypeSafeJevJudge)

function fakeProvider(id: string, canJudge = true): Provider {
  return {
    id,
    label: id.toUpperCase(),
    kind: 'api',
    secretEnv: [],
    effort: false,
    create: vi.fn(),
    doctor: vi.fn(),
    ...(canJudge ? { judge: vi.fn(() => () => Promise.resolve(`${id} reply`)) } : {}),
  }
}

const setup = { cwd: '/tmp', omitEnv: ['SECRET'], env: { A: '1' } }
const providers = [fakeProvider('a'), fakeProvider('b'), fakeProvider('mute', false)]

beforeEach(() => {
  TypeSafe.mockReset()
})

describe('panelProviders', () => {
  it('lists each provider once, in the order of the panel', () => {
    const panel = [{ provider: 'b' }, { provider: 'a' }, { provider: 'b', model: 'x' }]
    expect(panelProviders(panel, providers).map(({ id }) => id)).toEqual(['b', 'a'])
  })

  it('refuses a provider that does not exist or cannot judge', () => {
    expect(() => panelProviders([{ provider: 'zz' }], providers)).toThrow(
      'judge.panel: unknown provider zz',
    )
    expect(() => panelProviders([{ provider: 'mute' }], providers)).toThrow(
      'judge.panel: MUTE cannot judge',
    )
  })

  it('knows every real provider, and each can judge', () => {
    expect(() =>
      panelProviders(
        ['codex', 'claude', 'deepseek', 'kimi', 'glm'].map((provider) => ({ provider })),
      ),
    ).not.toThrow()
  })
})

describe('judgePanel', () => {
  it('names each model after its provider and model, with its weight', async () => {
    const panel = judgePanel(
      [{ provider: 'a' }, { provider: 'b', model: 'big', weight: 2 }],
      setup,
      providers,
    )
    expect(panel.map(({ id, weight }) => ({ id, weight }))).toEqual([
      { id: 'a', weight: undefined },
      { id: 'b/big', weight: 2 },
    ])
    expect(providers[0]?.judge).toHaveBeenCalledWith(setup)
    expect(providers[1]?.judge).toHaveBeenCalledWith({ ...setup, model: 'big' })
    await expect(
      panel[1]?.complete({
        system: '',
        prompt: '',
        schema: {},
        signal: new AbortController().signal,
      }),
    ).resolves.toBe('b reply')
  })

  it('builds nothing when one entry cannot judge', () => {
    const judge = vi.fn()
    const first = { ...fakeProvider('first'), judge }
    expect(() =>
      judgePanel([{ provider: 'first' }, { provider: 'mute' }], setup, [first, ...providers]),
    ).toThrow('cannot judge')
    expect(judge).not.toHaveBeenCalled()
  })
})

describe('createJevJudge', () => {
  it('builds the graph judge from the config', () => {
    const judge = createJevJudge(
      {
        kind: 'graph',
        panel: [{ provider: 'a' }],
        samples: 3,
        maxCalls: 9,
        timeoutMs: 1_000,
        claimChecks: true,
      },
      setup,
      providers,
    )
    expect(judge).toBeInstanceOf(GraphJevJudge)
    expect(
      createJevJudge({ kind: 'graph', panel: [{ provider: 'a' }] }, setup, providers),
    ).toBeInstanceOf(GraphJevJudge)
  })

  it('loads TypeSafe only on the first verdict, and once', async () => {
    const verdict = { model: 'jev' } as JevVerdict
    const judge = vi.fn(() => Promise.resolve(verdict))
    TypeSafe.mockImplementation(function (this: { judge: typeof judge }) {
      this.judge = judge
    } as never)
    const jev = createJevJudge({ kind: 'typesafe' }, setup)
    expect(TypeSafe).not.toHaveBeenCalled()
    const input = { task: 't', plans: [], stage: 'draft' } as const
    await expect(jev.judge(input)).resolves.toBe(verdict)
    await jev.judge(input)
    expect(TypeSafe).toHaveBeenCalledOnce()
    expect(judge).toHaveBeenCalledTimes(2)
  })
})
