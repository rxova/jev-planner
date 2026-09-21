import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import packageJson from '../../package.json' with { type: 'json' }
import { HELP, main, VERSION } from '../cli.js'
import type { CliDeps, ModelOverrides } from '../cli.js'
import type { CheckResult } from '../doctor.js'
import type { JevVerdict, PlanOptions, PlanResult } from '../types.js'

/** A rejection with a non-Error reason: what the `String(error)` fallback is for. */
function rejectWith(reason: unknown): Promise<never> {
  // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the point of the test
  return Promise.reject(reason)
}

const verdict: JevVerdict = {
  strongerPlan: 'codex',
  strongerPlanConfidence: 0.7,
  finalizer: 'codex',
  finalizerConfidence: 0.6,
  completeness: 3,
  completenessConfidence: 0.9,
  feasibility: 3,
  feasibilityConfidence: 0.9,
  riskCoverage: 2,
  riskCoverageConfidence: 0.8,
  needsAnotherPassProbability: 0.1,
  model: 'jev-test',
}

const result: PlanResult = {
  plan: '  # The plan  \n',
  verdict,
  finalizer: 'codex',
  drafts: { codex: 'codex draft', claude: 'claude draft' },
}

interface Harness {
  deps: CliDeps
  stdout: () => string
  stderr: () => string
  planned: () => PlanOptions | undefined
  models: () => ModelOverrides | undefined
}

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'jev-planner-cli-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function harness(overrides: Partial<CliDeps> = {}): Harness {
  let out = ''
  let err = ''
  let planned: PlanOptions | undefined
  let models: ModelOverrides | undefined
  const deps: CliDeps = {
    stdout: (text) => (out += text),
    stderr: (text) => (err += text),
    env: { TYPESAFE_API_KEY: 'key' },
    cwd: () => dir,
    readStdin: () => Promise.resolve(undefined),
    createPlanner: (overrides) => {
      models = overrides
      return {
        plan: (options) => {
          planned = options
          options.onStage?.('Drafting…')
          return Promise.resolve(result)
        },
      }
    },
    doctor: () => Promise.resolve([]),
    ...overrides,
  }
  return {
    deps,
    stdout: () => out,
    stderr: () => err,
    planned: () => planned,
    models: () => models,
  }
}

describe('main', () => {
  it('prints help', async () => {
    const h = harness()
    await expect(main(['--help'], h.deps)).resolves.toBe(0)
    expect(h.stdout()).toBe(`${HELP}\n`)
  })

  it("prints the package's version", async () => {
    const h = harness()
    await expect(main(['-v'], h.deps)).resolves.toBe(0)
    expect(VERSION).toBe(packageJson.version)
    expect(h.stdout()).toBe(`${VERSION}\n`)
  })

  it('plans a task given as arguments, with defaults', async () => {
    const h = harness()
    await expect(main(['Add', 'caching'], h.deps)).resolves.toBe(0)
    expect(h.planned()).toMatchObject({
      task: 'Add caching',
      cwd: dir,
      timeoutMs: 600_000,
      maxReviewRounds: 2,
    })
    expect(h.planned()).not.toHaveProperty('jevModel')
    expect(h.planned()).not.toHaveProperty('finalizer')
    expect(h.planned()).not.toHaveProperty('allowAnyTask')
    expect(h.models()).toEqual({})
    expect(h.stdout()).toBe('# The plan\n')
    expect(h.stderr()).toBe('[jev-planner] Drafting…\n')
  })

  it('passes every option through to the planner', async () => {
    const h = harness()
    const code = await main(
      [
        'plan',
        '--codex-model',
        'gpt-x',
        '--claude-model',
        'opus',
        '--jev-model',
        'jev-custom',
        '--finalizer',
        'claude',
        '--review-rounds',
        '1',
        '--timeout',
        '1.5',
        'Add caching',
      ],
      h.deps,
    )
    expect(code).toBe(0)
    expect(h.models()).toEqual({ codexModel: 'gpt-x', claudeModel: 'opus' })
    expect(h.planned()).toMatchObject({
      task: 'Add caching',
      timeoutMs: 1_500,
      maxReviewRounds: 1,
      jevModel: 'jev-custom',
      finalizer: 'claude',
    })
  })

  it('accepts the explicit defaults for finalizer and review rounds', async () => {
    const h = harness()
    await main(['--finalizer', 'auto', '--review-rounds', '2', 'task'], h.deps)
    expect(h.planned()).toMatchObject({ maxReviewRounds: 2 })
    expect(h.planned()).not.toHaveProperty('finalizer')
  })

  it('reads the task from a file, relative to the working directory', async () => {
    await writeFile(join(dir, 'task.md'), '  Task from a file \n')
    const h = harness()
    await expect(main(['-f', 'task.md'], h.deps)).resolves.toBe(0)
    expect(h.planned()?.task).toBe('Task from a file')
  })

  it('reads the task from stdin when none is given', async () => {
    const h = harness({ readStdin: () => Promise.resolve('Piped task') })
    await expect(main([], h.deps)).resolves.toBe(0)
    expect(h.planned()?.task).toBe('Piped task')
  })

  it('resolves --cwd against the working directory', async () => {
    const h = harness()
    await expect(main(['-C', '.', 'task'], h.deps)).resolves.toBe(0)
    expect(h.planned()?.cwd).toBe(dir)
  })

  it('emits JSON and the verdict when asked', async () => {
    const h = harness()
    await expect(main(['--json', '--verbose', 'task'], h.deps)).resolves.toBe(0)
    expect(JSON.parse(h.stdout())).toEqual({
      plan: result.plan,
      verdict,
      finalizer: 'codex',
    })
    expect(h.stderr()).toContain(
      `[jev-planner] Jev verdict:\n${JSON.stringify(verdict, null, 2)}\n`,
    )
  })

  it('writes the plan to --output, relative to --cwd', async () => {
    const h = harness()
    await expect(main(['-o', 'PLAN.md', 'task'], h.deps)).resolves.toBe(0)
    await expect(readFile(join(dir, 'PLAN.md'), 'utf8')).resolves.toBe('# The plan\n')
    expect(h.stdout()).toBe('')
    expect(h.stderr()).toContain(`[jev-planner] Wrote ${join(dir, 'PLAN.md')}\n`)
  })

  it('plans a placeholder task with --allow-any-task', async () => {
    const h = harness()
    await expect(main(['--allow-any-task', 'TODO'], h.deps)).resolves.toBe(0)
    expect(h.planned()).toMatchObject({ task: 'TODO', allowAnyTask: true })
  })

  it('still rejects an empty task with --allow-any-task, before the TypeSafe key', async () => {
    const h = harness({ env: {} })
    await expect(main(['--allow-any-task'], h.deps)).resolves.toBe(1)
    expect(h.stderr()).toBe(
      'jev-planner: Missing coding task. Pass it as an argument, with --file, or on stdin.\n',
    )
  })

  describe('doctor', () => {
    const check = (ok: boolean): CheckResult => ({ name: 'Codex CLI', ok, detail: 'detail' })

    it('prints each check and succeeds when all pass', async () => {
      const doctor = vi.fn(() => Promise.resolve([check(true)]))
      const h = harness({ doctor })
      await expect(main(['doctor'], h.deps)).resolves.toBe(0)
      expect(doctor).toHaveBeenCalledWith(dir)
      expect(h.stdout()).toBe('✓ Codex CLI: detail\n')
    })

    it('fails when any check fails', async () => {
      const h = harness({ doctor: () => Promise.resolve([check(true), check(false)]) })
      await expect(main(['doctor'], h.deps)).resolves.toBe(1)
      expect(h.stdout()).toContain('✗ Codex CLI: detail\n')
    })

    it('rejects a task', async () => {
      const h = harness()
      await expect(main(['doctor', 'task'], h.deps)).resolves.toBe(1)
      expect(h.stderr()).toBe('jev-planner: doctor does not accept a task\n')
    })
  })

  describe('errors', () => {
    async function failure(argv: string[], overrides: Partial<CliDeps> = {}): Promise<string> {
      const h = harness(overrides)
      await expect(main(argv, h.deps)).resolves.toBe(1)
      expect(h.planned()).toBeUndefined()
      return h.stderr()
    }

    it('rejects a missing working directory', async () => {
      const missing = join(dir, 'missing')
      await expect(failure(['-C', missing, 'task'])).resolves.toBe(
        `jev-planner: Not a directory: ${missing}\n`,
      )
    })

    it('rejects a task given both ways', async () => {
      await expect(failure(['-f', 'task.md', 'task'])).resolves.toContain('not both')
    })

    it('rejects a missing task', async () => {
      await expect(failure([])).resolves.toContain('Missing coding task')
      await expect(failure([], { readStdin: () => Promise.resolve('') })).resolves.toContain(
        'Missing coding task',
      )
    })

    it('rejects a placeholder task before checking the TypeSafe key', async () => {
      const placeholder = 'Describe the coding change you want to plan'
      await expect(failure([placeholder], { env: {} })).resolves.toContain(
        'looks like a placeholder',
      )
      await expect(
        failure([], { env: {}, readStdin: () => Promise.resolve('TODO') }),
      ).resolves.toContain('--allow-any-task')
    })

    it('rejects a missing TypeSafe key', async () => {
      await expect(failure(['task'], { env: { TYPESAFE_API_KEY: ' ' } })).resolves.toContain(
        'TYPESAFE_API_KEY is not set',
      )
      await expect(failure(['task'], { env: {} })).resolves.toContain('TYPESAFE_API_KEY is not set')
    })

    it('rejects invalid option values', async () => {
      await expect(failure(['--finalizer', 'jev', 'task'])).resolves.toContain(
        'Invalid --finalizer value: jev',
      )
      await expect(failure(['--review-rounds', '3', 'task'])).resolves.toContain(
        '--review-rounds must be 1 or 2',
      )
      await expect(failure(['--timeout', '0', 'task'])).resolves.toContain(
        '--timeout must be a positive number',
      )
      await expect(failure(['--timeout', 'soon', 'task'])).resolves.toContain(
        '--timeout must be a positive number',
      )
    })

    it('rejects an unknown option', async () => {
      await expect(failure(['--nope'])).resolves.toMatch(/^jev-planner: Unknown option '--nope'/)
    })

    it('reports a non-Error failure', async () => {
      const h = harness({ createPlanner: () => ({ plan: () => rejectWith('planner down') }) })
      await expect(main(['task'], h.deps)).resolves.toBe(1)
      expect(h.stderr()).toBe('jev-planner: planner down\n')
    })
  })
})
