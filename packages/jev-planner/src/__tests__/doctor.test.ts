import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runDoctor } from '../doctor.js'
import { runProcess } from '../process.js'
import type { ProcessResult } from '../process.js'

vi.mock('../process.js', () => ({ runProcess: vi.fn() }))

const run = vi.mocked(runProcess)

type Responder = () => Promise<ProcessResult>

function ok(stdout: string, stderr = ''): Responder {
  return () => Promise.resolve({ stdout, stderr, exitCode: 0 })
}

function respond(responses: Record<string, Responder>): void {
  run.mockImplementation((command, args) => {
    const responder = responses[[command, ...args].join(' ')]
    if (!responder) throw new Error(`unexpected command: ${command}`)
    return responder()
  })
}

/** A rejection with a non-Error reason: what the `String(error)` fallback is for. */
function rejectWith(reason: unknown): Promise<never> {
  // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the point of the test
  return Promise.reject(reason)
}

const loggedIn = JSON.stringify({ loggedIn: true, authMethod: 'oauth', subscriptionType: 'max' })

beforeEach(() => {
  run.mockReset()
  vi.stubEnv('TYPESAFE_API_KEY', 'key')
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('runDoctor', () => {
  it('reports every check passing', async () => {
    respond({
      'codex --version': ok('codex-cli 1.2.3\nextra'),
      'codex login status': ok('', 'Logged in using ChatGPT'),
      'claude --version': ok(''),
      'claude auth status --json': ok(loggedIn),
    })
    await expect(runDoctor('/repo')).resolves.toEqual([
      { name: 'Codex CLI', ok: true, detail: 'codex-cli 1.2.3' },
      { name: 'Codex auth', ok: true, detail: 'Logged in using ChatGPT' },
      { name: 'Claude CLI', ok: true, detail: 'available' },
      { name: 'Claude auth', ok: true, detail: 'Logged in (oauth, max)' },
      { name: 'TypeSafe key', ok: true, detail: 'TYPESAFE_API_KEY is set' },
    ])
    expect(run).toHaveBeenCalledWith('codex', ['--version'], { cwd: '/repo', timeoutMs: 15_000 })
  })

  it('reports every check failing', async () => {
    vi.stubEnv('TYPESAFE_API_KEY', '  ')
    respond({
      'codex --version': () => Promise.reject(new Error('Could not start codex: ENOENT\nstack')),
      'codex login status': () => Promise.reject(new Error('Not logged in')),
      'claude --version': () => rejectWith('plain string'),
      'claude auth status --json': ok(JSON.stringify({ loggedIn: false })),
    })
    await expect(runDoctor('/repo')).resolves.toEqual([
      { name: 'Codex CLI', ok: false, detail: 'Could not start codex: ENOENT' },
      { name: 'Codex auth', ok: false, detail: 'Not logged in' },
      { name: 'Claude CLI', ok: false, detail: 'plain string' },
      { name: 'Claude auth', ok: false, detail: 'Not logged in' },
      { name: 'TypeSafe key', ok: false, detail: 'TYPESAFE_API_KEY is not set' },
    ])
  })

  it('reports a login without plan details', async () => {
    respond({
      'codex --version': ok('1'),
      'codex login status': ok('ok'),
      'claude --version': ok('2'),
      'claude auth status --json': ok(JSON.stringify({ loggedIn: true })),
    })
    const checks = await runDoctor('/repo')
    expect(checks[3]).toEqual({ name: 'Claude auth', ok: true, detail: 'Logged in' })
  })

  it('reports an unreadable Claude auth status', async () => {
    vi.stubEnv('TYPESAFE_API_KEY', undefined)
    respond({
      'codex --version': ok('1'),
      'codex login status': ok('ok'),
      'claude --version': ok('2'),
      'claude auth status --json': ok('not json'),
    })
    const checks = await runDoctor('/repo')
    expect(checks[3]).toMatchObject({ name: 'Claude auth', ok: false })
    expect(checks[3]?.detail).toMatch(/JSON/)
    expect(checks[4]?.ok).toBe(false)
  })

  it('reports a non-Error failure from Claude auth', async () => {
    respond({
      'codex --version': ok('1'),
      'codex login status': ok('ok'),
      'claude --version': ok('2'),
      'claude auth status --json': () => rejectWith(42),
    })
    const checks = await runDoctor('/repo')
    expect(checks[3]).toEqual({ name: 'Claude auth', ok: false, detail: '42' })
  })
})
