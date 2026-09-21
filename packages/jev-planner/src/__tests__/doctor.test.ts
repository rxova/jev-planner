import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { commandCheck, envCheck, errorDetail, runDoctor } from '../doctor.js'
import { runProcess } from '../process.js'
import type { Provider } from '../provider.js'

vi.mock('../process.js', () => ({ runProcess: vi.fn() }))

const run = vi.mocked(runProcess)

/** A rejection with a non-Error reason: what the `String(error)` fallback is for. */
function rejectWith(reason: unknown): Promise<never> {
  // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the point of the test
  return Promise.reject(reason)
}

function fakeProvider(id: string, ok: boolean): Provider {
  return {
    id,
    label: id,
    kind: 'api',
    secretEnv: [],
    effort: false,
    create: () => {
      throw new Error('not used')
    },
    doctor: (cwd) => Promise.resolve([{ name: `${id} check`, ok, detail: cwd }]),
  }
}

beforeEach(() => {
  run.mockReset()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('commandCheck', () => {
  it('passes with the first line printed, stderr when stdout is empty, or "available"', async () => {
    run.mockResolvedValueOnce({ stdout: 'codex-cli 1.2.3\nextra', stderr: '', exitCode: 0 })
    run.mockResolvedValueOnce({ stdout: '', stderr: 'Logged in', exitCode: 0 })
    run.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })
    await expect(commandCheck('A', 'a', ['--version'], '/repo')).resolves.toEqual({
      name: 'A',
      ok: true,
      detail: 'codex-cli 1.2.3',
    })
    await expect(commandCheck('B', 'b', [], '/repo')).resolves.toMatchObject({
      detail: 'Logged in',
    })
    await expect(commandCheck('C', 'c', [], '/repo')).resolves.toMatchObject({
      detail: 'available',
    })
    expect(run).toHaveBeenCalledWith('a', ['--version'], { cwd: '/repo', timeoutMs: 15_000 })
  })

  it('fails with the first line of the error, or a non-Error reason', async () => {
    run.mockRejectedValueOnce(new Error('Could not start codex: ENOENT\nstack'))
    run.mockImplementationOnce(() => rejectWith('plain string'))
    await expect(commandCheck('A', 'a', [], '/repo')).resolves.toEqual({
      name: 'A',
      ok: false,
      detail: 'Could not start codex: ENOENT',
    })
    await expect(commandCheck('B', 'b', [], '/repo')).resolves.toMatchObject({
      ok: false,
      detail: 'plain string',
    })
  })
})

describe('envCheck', () => {
  it('reports whether a variable is set, never its value', () => {
    expect(envCheck('K', 'KEY', { KEY: 'secret' })).toEqual({
      name: 'K',
      ok: true,
      detail: 'KEY is set',
    })
    expect(envCheck('K', 'KEY', { KEY: '  ' })).toEqual({
      name: 'K',
      ok: false,
      detail: 'KEY is not set',
    })
  })
})

describe('errorDetail', () => {
  it('reads an Error message or stringifies anything else', () => {
    expect(errorDetail(new Error('one\ntwo'))).toBe('one')
    expect(errorDetail(42)).toBe('42')
  })
})

describe('runDoctor', () => {
  it("runs each provider's checks in order, then the TypeSafe key", async () => {
    const checks = await runDoctor('/repo', [fakeProvider('a', true), fakeProvider('b', false)], {
      TYPESAFE_API_KEY: 'key',
    })
    expect(checks).toEqual([
      { name: 'a check', ok: true, detail: '/repo' },
      { name: 'b check', ok: false, detail: '/repo' },
      { name: 'TypeSafe key', ok: true, detail: 'TYPESAFE_API_KEY is set' },
    ])
  })

  it('reads process.env by default', async () => {
    vi.stubEnv('TYPESAFE_API_KEY', '')
    await expect(runDoctor('/repo', [])).resolves.toEqual([
      { name: 'TypeSafe key', ok: false, detail: 'TYPESAFE_API_KEY is not set' },
    ])
  })
})
