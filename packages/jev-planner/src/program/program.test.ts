import { main, secretEnv } from '@rxova/planner-core'
import type { CliDeps } from '@rxova/planner-core'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import packageJson from '../../package.json' with { type: 'json' }
import { JEV_PLANNER } from './program.js'

async function run(argv: string[], env: CliDeps['env'] = {}) {
  let out = ''
  let err = ''
  const deps: CliDeps = {
    stdout: (text) => (out += text),
    stderr: (text) => (err += text),
    env,
    cwd: () => tmpdir(),
    readStdin: () => Promise.resolve(undefined),
    createPlanner: () => {
      throw new Error('not used')
    },
    doctor: () => Promise.resolve([]),
    now: () => new Date('2026-09-22T10:00:00Z'),
    program: JEV_PLANNER,
  }
  const code = await main(argv, deps)
  return { code, out, err }
}

describe('JEV_PLANNER', () => {
  it("prints the package's version", async () => {
    await expect(run(['--version'])).resolves.toEqual({
      code: 0,
      out: `${packageJson.version}\n`,
      err: '',
    })
  })

  it('names Jev as the judge in the help', async () => {
    const { out } = await run(['--help'])
    expect(out).toMatch(/^jev-planner /)
    expect(out).toContain('judged by Jev')
    expect(out).toContain("Override Jev's model (default: SDK's jev-latest)")
  })

  it('needs the TypeSafe key before a run, and keeps it from every agent', async () => {
    const { code, err } = await run(['--no-config', 'Add caching'])
    expect(code).toBe(1)
    expect(err).toBe(
      'jev-planner: TYPESAFE_API_KEY is not set. Create a key at https://console.typesafe.ai/keys and export it first.\n',
    )
    expect(secretEnv(JEV_PLANNER)[0]).toBe('TYPESAFE_API_KEY')
  })
})
