import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runProcess } from '../process.js'
import type { Provider } from '../provider.js'
import { DEFAULT_AGENTS, PROVIDERS } from '../providers.js'

vi.mock('../process.js', () => ({ runProcess: vi.fn() }))

const run = vi.mocked(runProcess)
const request = { prompt: 'plan it', cwd: '/repo', timeoutMs: 1_000 }
const setup = { omitEnv: ['TYPESAFE_API_KEY', 'DEEPSEEK_API_KEY'], env: {} }

function provider(id: string): Provider {
  const found = PROVIDERS.find((candidate) => candidate.id === id)
  if (!found) throw new Error(`no provider ${id}`)
  return found
}

/** A rejection with a non-Error reason: what the `String(error)` fallback is for. */
function rejectWith(reason: unknown): Promise<never> {
  // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the point of the test
  return Promise.reject(reason)
}

beforeEach(() => {
  run.mockReset()
  run.mockResolvedValue({ stdout: '  the plan \n', stderr: '', exitCode: 0 })
})

describe('PROVIDERS', () => {
  it('has unique lowercase ids, and the defaults are among them', () => {
    const ids = PROVIDERS.map(({ id }) => id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(id).toMatch(/^[a-z][a-z0-9-]*$/)
    for (const id of DEFAULT_AGENTS) expect(ids).toContain(id)
    expect(DEFAULT_AGENTS).toEqual(['codex', 'claude'])
  })

  it('declares a secret for every API agent', () => {
    for (const { kind, secretEnv } of PROVIDERS) {
      if (kind === 'api') expect(secretEnv).not.toHaveLength(0)
    }
  })
})

describe('codex', () => {
  it('runs codex read-only and ephemeral, prompt on stdin, without the secrets', async () => {
    const agent = provider('codex').create(setup)
    expect(agent).toMatchObject({ name: 'codex', label: 'Codex' })
    await expect(agent.generate(request)).resolves.toBe('the plan')
    expect(run).toHaveBeenCalledWith(
      'codex',
      [
        'exec',
        '--ephemeral',
        '--sandbox',
        'read-only',
        '--skip-git-repo-check',
        '--color',
        'never',
        '-',
      ],
      { cwd: '/repo', input: 'plan it', timeoutMs: 1_000, omitEnv: setup.omitEnv },
    )
  })

  it('passes a model override before the stdin marker', async () => {
    await provider('codex')
      .create({ ...setup, model: 'gpt-x' })
      .generate(request)
    expect(run.mock.calls[0]?.[1].slice(-3)).toEqual(['--model', 'gpt-x', '-'])
  })

  it('rejects an empty response', async () => {
    run.mockResolvedValue({ stdout: ' \n', stderr: '', exitCode: 0 })
    await expect(provider('codex').create(setup).generate(request)).rejects.toThrow(
      'Codex returned an empty response',
    )
  })

  it('checks the CLI and its login', async () => {
    run.mockImplementation((_command, args) =>
      args[0] === 'login'
        ? Promise.reject(new Error('Not logged in'))
        : Promise.resolve({ stdout: 'codex-cli 1', stderr: '', exitCode: 0 }),
    )
    await expect(provider('codex').doctor('/repo', {})).resolves.toEqual([
      { name: 'Codex CLI', ok: true, detail: 'codex-cli 1' },
      { name: 'Codex auth', ok: false, detail: 'Not logged in' },
    ])
    expect(run).toHaveBeenCalledWith('codex', ['login', 'status'], {
      cwd: '/repo',
      timeoutMs: 15_000,
    })
  })
})

describe('claude', () => {
  it('runs claude in plan mode with read-only tools, without the secrets', async () => {
    const agent = provider('claude').create(setup)
    expect(agent).toMatchObject({ name: 'claude', label: 'Claude' })
    await expect(agent.generate(request)).resolves.toBe('the plan')
    const [command, args, options] = run.mock.calls[0]!
    expect(command).toBe('claude')
    expect(args).toContain('--print')
    expect(args.join(' ')).toContain('--permission-mode plan')
    expect(args.join(' ')).toContain('--tools Read,Glob,Grep')
    expect(args).not.toContain('--model')
    expect(options).toEqual({
      cwd: '/repo',
      input: 'plan it',
      timeoutMs: 1_000,
      omitEnv: setup.omitEnv,
    })
  })

  it('passes a model override', async () => {
    await provider('claude')
      .create({ ...setup, model: 'opus' })
      .generate(request)
    expect(run.mock.calls[0]?.[1].slice(-2)).toEqual(['--model', 'opus'])
  })

  describe('auth check', () => {
    function authWith(status: () => Promise<{ stdout: string; stderr: string; exitCode: number }>) {
      run.mockImplementation((_command, args) =>
        args[0] === 'auth' ? status() : Promise.resolve({ stdout: '2', stderr: '', exitCode: 0 }),
      )
      return provider('claude').doctor('/repo', {})
    }
    const out = (stdout: string) => () => Promise.resolve({ stdout, stderr: '', exitCode: 0 })

    it('reports a login with its method and plan', async () => {
      const loggedIn = { loggedIn: true, authMethod: 'oauth', subscriptionType: 'max' }
      await expect(authWith(out(JSON.stringify(loggedIn)))).resolves.toEqual([
        { name: 'Claude CLI', ok: true, detail: '2' },
        { name: 'Claude auth', ok: true, detail: 'Logged in (oauth, max)' },
      ])
    })

    it('reports a login without plan details', async () => {
      const checks = await authWith(out(JSON.stringify({ loggedIn: true })))
      expect(checks[1]).toEqual({ name: 'Claude auth', ok: true, detail: 'Logged in' })
    })

    it('reports no login', async () => {
      const checks = await authWith(out(JSON.stringify({ loggedIn: false })))
      expect(checks[1]).toEqual({ name: 'Claude auth', ok: false, detail: 'Not logged in' })
    })

    it('reports an unreadable status', async () => {
      const checks = await authWith(out('not json'))
      expect(checks[1]).toMatchObject({ name: 'Claude auth', ok: false })
      expect(checks[1]?.detail).toMatch(/JSON/)
    })

    it('reports a non-Error failure', async () => {
      const checks = await authWith(() => rejectWith(42))
      expect(checks[1]).toEqual({ name: 'Claude auth', ok: false, detail: '42' })
    })
  })
})
