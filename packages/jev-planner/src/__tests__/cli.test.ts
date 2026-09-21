import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import packageJson from '../../package.json' with { type: 'json' }
import { HELP, main, VERSION } from '../cli.js'
import type { CliDeps } from '../cli.js'
import type { CheckResult } from '../doctor.js'
import { PROVIDERS } from '../providers.js'
import type { JevVerdict, PlanOptions, PlanResult, PlanRound } from '../types.js'

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
  timings: { totalMs: 312_000, rounds: [] },
}

interface Harness {
  deps: CliDeps
  stdout: () => string
  stderr: () => string
  planned: () => PlanOptions | undefined
  /** The agent ids and model overrides the planner was created with. */
  setup: () =>
    | {
        agents: string[]
        models: Readonly<Record<string, string>>
        efforts: Readonly<Record<string, string>>
      }
    | undefined
}

let dir: string

/** The harness clock, so the default run folder has a known name. */
const NOW = new Date('2026-09-21T23:05:12.345Z')
const RUN = '20260921-230512'

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
  let setup: ReturnType<Harness['setup']>
  const deps: CliDeps = {
    stdout: (text) => (out += text),
    stderr: (text) => (err += text),
    env: { TYPESAFE_API_KEY: 'key' },
    cwd: () => dir,
    readStdin: () => Promise.resolve(undefined),
    createPlanner: ({ agents, models, efforts }) => {
      setup = { agents: agents.map(({ id }) => id), models, efforts }
      return {
        plan: (options) => {
          planned = options
          options.onStage?.('Drafting…')
          return Promise.resolve(result)
        },
      }
    },
    doctor: () => Promise.resolve([]),
    now: () => NOW,
    ...overrides,
  }
  return {
    deps,
    stdout: () => out,
    stderr: () => err,
    planned: () => planned,
    setup: () => setup,
  }
}

describe('main', () => {
  it('prints help', async () => {
    const h = harness()
    await expect(main(['--help'], h.deps)).resolves.toBe(0)
    expect(h.stdout()).toBe(`${HELP}\n`)
  })

  it('lists every registered agent in the help, with what an API agent needs', () => {
    for (const { id, label } of PROVIDERS)
      expect(HELP).toMatch(new RegExp(`^  ${id} +${label}: `, 'm'))
    expect(HELP).toContain('Codex: agent CLI, reads the repository; takes --effort')
    expect(HELP).toContain('DeepSeek: chat API, gets a repository snapshot; needs DEEPSEEK_API_KEY')
    expect(HELP).toContain('(default: codex,claude)')
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
    expect(h.setup()).toEqual({ agents: ['codex', 'claude'], models: {}, efforts: {} })
    expect(h.stdout()).toBe('# The plan\n')
    expect(h.stderr()).toBe(
      `[jev-planner] Writing rounds to ${join(dir, '.jev-planner', RUN)}\n[jev-planner] Drafting…\n`,
    )
  })

  it('passes every option through to the planner', async () => {
    const h = harness()
    const code = await main(
      [
        'plan',
        '--agents',
        ' Codex, claude ,glm,',
        '--model',
        'codex=gpt-x',
        '-m',
        'GLM= glm-5 ',
        '--effort',
        'codex=low',
        '-e',
        'Claude=high',
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
    expect(h.setup()).toEqual({
      agents: ['codex', 'claude', 'glm'],
      models: { codex: 'gpt-x', glm: 'glm-5' },
      efforts: { codex: 'low', claude: 'high' },
    })
    expect(h.planned()).toMatchObject({
      task: 'Add caching',
      timeoutMs: 1_500,
      maxReviewRounds: 1,
      jevModel: 'jev-custom',
      finalizer: 'claude',
    })
  })

  it('passes --review-effort to the planner for the later stages only', async () => {
    const h = harness()
    await main(['--effort', 'codex=xhigh', '--review-effort', 'codex=low', 'task'], h.deps)
    expect(h.setup()?.efforts).toEqual({ codex: 'xhigh' })
    expect(h.planned()?.reviewEfforts).toEqual({ codex: 'low' })
    await main(['task'], h.deps)
    expect(h.planned()).not.toHaveProperty('reviewEfforts')
  })

  it('rejects --review-effort for an agent that takes no effort', async () => {
    const h = harness()
    await expect(
      main(['--agents', 'codex,deepseek', '--review-effort', 'deepseek=low', 'task'], h.deps),
    ).resolves.toBe(1)
    expect(h.stderr()).toBe('jev-planner: DeepSeek does not take --review-effort\n')
  })

  it('resumes sessions by default, and not with --no-resume', async () => {
    const h = harness()
    await main(['task'], h.deps)
    expect(h.planned()).not.toHaveProperty('resume')
    await main(['--no-resume', 'task'], h.deps)
    expect(h.planned()).toMatchObject({ resume: false })
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
      timings: result.timings,
    })
    expect(h.stderr()).toContain(
      `[jev-planner] Jev verdict:\n${JSON.stringify(verdict, null, 2)}\n`,
    )
  })

  it("streams each agent's work with --verbose, one prefixed line each", async () => {
    const progressing = (): Partial<CliDeps> => ({
      createPlanner: () => ({
        plan: (options) => {
          options.onAgentProgress?.('codex', '$ ls apps/docs')
          options.onAgentProgress?.('claude', 'Read a.ts\nGrep deploy')
          return Promise.resolve(result)
        },
      }),
    })
    const verbose = harness(progressing())
    await expect(main(['--verbose', 'task'], verbose.deps)).resolves.toBe(0)
    expect(verbose.stderr()).toContain(
      '[codex] $ ls apps/docs\n[claude] Read a.ts\n[claude] Grep deploy\n',
    )

    const quiet = harness(progressing())
    await expect(main(['task'], quiet.deps)).resolves.toBe(0)
    expect(quiet.stderr()).not.toContain('[codex]')
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

  describe('--rounds-dir', () => {
    const rounds: PlanRound[] = [
      {
        round: 1,
        stage: 'draft',
        plans: { codex: ' codex draft ', claude: 'claude draft' },
        timings: { totalMs: 252_000, agents: { codex: 252_000, claude: 171_400 } },
      },
      {
        round: 2,
        stage: 'review',
        plans: { codex: 'codex revised', claude: 'x' },
        verdict,
        timings: { totalMs: 65_000, agents: { codex: 58_000, claude: 41_000 }, jevMs: 7_000 },
      },
      {
        round: 3,
        stage: 'final',
        plans: { codex: 'merged\n' },
        verdict,
        timings: { totalMs: 9_000, agents: { codex: 9_000 } },
      },
    ]
    const replaying = (): Partial<CliDeps> => ({
      createPlanner: () => ({
        plan: async (options) => {
          for (const round of rounds) await options.onRound?.(round)
          return result
        },
      }),
    })

    it('writes each round to its own folder, relative to --cwd', async () => {
      const h = harness(replaying())
      await expect(main(['--rounds-dir', 'out/rounds', 'task'], h.deps)).resolves.toBe(0)
      const out = join(dir, 'out/rounds')
      const read = (path: string) => readFile(join(out, path), 'utf8')
      await expect(read('round1/codex.md')).resolves.toBe('codex draft\n')
      await expect(read('round1/claude.md')).resolves.toBe('claude draft\n')
      await expect(readdir(join(out, 'round1'))).resolves.toHaveLength(3)
      expect(JSON.parse(await read('round1/timings.json'))).toEqual(rounds[0]?.timings)
      await expect(read('round2/codex.md')).resolves.toBe('codex revised\n')
      expect(JSON.parse(await read('round2/jev-verdict.json'))).toEqual(verdict)
      await expect(read('final/plan.md')).resolves.toBe('<!-- merged by codex -->\nmerged\n')
      await expect(read('final/jev-verdict.json')).resolves.toContain('"finalizer": "codex"')
      expect(JSON.parse(await read('final/timings.json'))).toEqual(rounds[2]?.timings)
    })

    it('with --finalizer none, marks a selected plan as selected rather than merged', async () => {
      const selected: PlanRound = {
        round: 3,
        stage: 'final',
        plans: { codex: 'codex revised' },
        verdict,
        timings: { totalMs: 20, agents: {} },
        selected: true,
      }
      const h = harness({
        createPlanner: () => ({
          plan: async (options) => {
            expect(options).toMatchObject({ selectStronger: true })
            expect(options).not.toHaveProperty('finalizer')
            await options.onRound?.(selected)
            return { ...result, selected: true }
          },
        }),
      })
      const args = ['--finalizer', 'none', '--rounds-dir', 'r', '--verbose', '--json', 'task']
      await expect(main(args, h.deps)).resolves.toBe(0)
      await expect(readFile(join(dir, 'r/final/plan.md'), 'utf8')).resolves.toBe(
        '<!-- selected from codex -->\ncodex revised\n',
      )
      expect(h.stderr()).toContain('[jev-planner] Final plan: 0.0s\n')
      expect(JSON.parse(h.stdout())).toMatchObject({ finalizer: 'codex', selected: true })
    })

    it('prints how long each round and call took with --verbose, and writes nothing', async () => {
      const h = harness(replaying())
      await expect(main(['--verbose', 'task'], h.deps)).resolves.toBe(0)
      expect(h.stderr()).toContain(
        [
          '[jev-planner] Drafts: 4m12s (Codex 4m12s, Claude 2m51s)',
          '[jev-planner] Review: 1m05s (Codex 58s, Claude 41s, Jev 7.0s)',
          '[jev-planner] Final plan: 9.0s (Codex 9.0s)',
          '[jev-planner] Total: 5m12s',
          '[jev-planner] Jev verdict:',
        ].join('\n'),
      )
      await expect(readdir(dir)).resolves.toEqual([])
    })

    it('says where the rounds go', async () => {
      const h = harness()
      await main(['--rounds-dir', 'out', 'task'], h.deps)
      expect(h.stderr()).toContain(`[jev-planner] Writing rounds to ${join(dir, 'out')}\n`)
      await expect(readdir(dir)).resolves.toEqual(['out'])
    })

    it('reuses an empty folder, and refuses one with files in it', async () => {
      await mkdir(join(dir, 'empty'))
      await expect(main(['--rounds-dir', 'empty', 'task'], harness().deps)).resolves.toBe(0)
      await writeFile(join(dir, 'empty', 'old.md'), 'old')
      const h = harness()
      await expect(main(['--rounds-dir', 'empty', 'task'], h.deps)).resolves.toBe(1)
      expect(h.stderr()).toBe(
        `jev-planner: --rounds-dir must be new or empty: ${join(dir, 'empty')}\n`,
      )
      expect(h.planned()).toBeUndefined()
    })

    it('reports a path it cannot use', async () => {
      await writeFile(join(dir, 'file'), 'x')
      const h = harness()
      await expect(main(['--rounds-dir', 'file', 'task'], h.deps)).resolves.toBe(1)
      expect(h.stderr()).toMatch(/^jev-planner: ENOTDIR/)
    })
  })

  describe('the default run folder', () => {
    const rounds: PlanRound[] = [
      { round: 1, stage: 'draft', plans: { codex: 'codex draft', claude: 'claude draft' } },
      { round: 2, stage: 'final', plans: { codex: 'merged' }, verdict },
    ]
    const replaying = (): Partial<CliDeps> => ({
      createPlanner: () => ({
        plan: async (options) => {
          for (const round of rounds) await options.onRound?.(round)
          return result
        },
      }),
    })
    const home = () => join(dir, '.jev-planner')

    it('writes the rounds to .jev-planner/<UTC start time>/ and keeps them out of git', async () => {
      const h = harness(replaying())
      await expect(main(['task'], h.deps)).resolves.toBe(0)
      await expect(readFile(join(home(), RUN, 'round1', 'codex.md'), 'utf8')).resolves.toBe(
        'codex draft\n',
      )
      await expect(readFile(join(home(), RUN, 'final', 'plan.md'), 'utf8')).resolves.toBe(
        '<!-- merged by codex -->\nmerged\n',
      )
      await expect(readFile(join(home(), '.gitignore'), 'utf8')).resolves.toMatch(/^\*$/m)
      expect(h.stderr()).toContain(`[jev-planner] Writing rounds to ${join(home(), RUN)}\n`)
    })

    it('never reuses a run folder, and leaves an existing .gitignore alone', async () => {
      await main(['task'], harness().deps)
      await writeFile(join(home(), '.gitignore'), 'mine\n')
      await main(['task'], harness().deps)
      await main(['task'], harness().deps)
      await expect(readdir(home())).resolves.toEqual(
        expect.arrayContaining([RUN, `${RUN}-2`, `${RUN}-3`]),
      )
      await expect(readFile(join(home(), '.gitignore'), 'utf8')).resolves.toBe('mine\n')
    })

    it('writes nothing with --no-rounds', async () => {
      const h = harness()
      await expect(main(['--no-rounds', 'task'], h.deps)).resolves.toBe(0)
      expect(h.planned()).not.toHaveProperty('onRound')
      await expect(readdir(dir)).resolves.toEqual([])
      expect(h.stderr()).not.toContain('Writing rounds')
    })

    it('refuses --no-rounds with --rounds-dir, before planning', async () => {
      const h = harness()
      await expect(main(['--no-rounds', '--rounds-dir', 'out', 'task'], h.deps)).resolves.toBe(1)
      expect(h.stderr()).toBe('jev-planner: Pass --rounds-dir or --no-rounds, not both\n')
      expect(h.planned()).toBeUndefined()
    })

    it('creates nothing when the task is rejected', async () => {
      await expect(main(['TODO'], harness().deps)).resolves.toBe(1)
      await expect(readdir(dir)).resolves.toEqual([])
    })

    it('reports a .jev-planner it cannot write to', async () => {
      await writeFile(home(), 'a file')
      const h = harness()
      await expect(main(['task'], h.deps)).resolves.toBe(1)
      expect(h.stderr()).toMatch(/^jev-planner: EEXIST/)
      expect(h.planned()).toBeUndefined()
    })

    // Permission bits do not stop root, and Windows ignores them.
    const canLockOut = process.platform !== 'win32' && process.getuid?.() !== 0
    it.runIf(canLockOut)(
      'reports a read-only .jev-planner, with or without its .gitignore',
      async () => {
        await mkdir(home())
        await chmod(home(), 0o555)
        try {
          const bare = harness()
          await expect(main(['task'], bare.deps)).resolves.toBe(1)
          expect(bare.stderr()).toMatch(/^jev-planner: EACCES.*\.gitignore/)

          await chmod(home(), 0o755)
          await writeFile(join(home(), '.gitignore'), '*\n')
          await chmod(home(), 0o555)
          const ignored = harness()
          await expect(main(['task'], ignored.deps)).resolves.toBe(1)
          expect(ignored.stderr()).toMatch(new RegExp(`^jev-planner: EACCES.*${RUN}`))
        } finally {
          await chmod(home(), 0o755)
        }
      },
    )
  })

  describe('doctor', () => {
    const check = (ok: boolean): CheckResult => ({ name: 'Codex CLI', ok, detail: 'detail' })

    it('prints each check and succeeds when all pass', async () => {
      const doctor = vi.fn<CliDeps['doctor']>(() => Promise.resolve([check(true)]))
      const h = harness({ doctor })
      await expect(main(['doctor'], h.deps)).resolves.toBe(0)
      expect(doctor.mock.calls[0]?.[0]).toBe(dir)
      expect(doctor.mock.calls[0]?.[1].map(({ id }) => id)).toEqual(['codex', 'claude'])
      expect(h.stdout()).toBe('✓ Codex CLI: detail\n')
    })

    it('fails when any check fails', async () => {
      const h = harness({ doctor: () => Promise.resolve([check(true), check(false)]) })
      await expect(main(['doctor'], h.deps)).resolves.toBe(1)
      expect(h.stdout()).toContain('✗ Codex CLI: detail\n')
    })

    it('checks the selected agents', async () => {
      const doctor = vi.fn<CliDeps['doctor']>(() => Promise.resolve([]))
      await main(['doctor', '--agents', 'deepseek,kimi'], harness({ doctor }).deps)
      expect(doctor.mock.calls[0]?.[1].map(({ id }) => id)).toEqual(['deepseek', 'kimi'])
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
        'Invalid --finalizer value: jev. Expected auto, none or one of codex, claude.',
      )
      await expect(failure(['--finalizer', 'glm', 'task'])).resolves.toContain(
        'Invalid --finalizer value: glm',
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

    it('rejects an invalid agent list', async () => {
      await expect(failure(['--agents', 'codex,gpt9', 'task'])).resolves.toContain(
        'Unknown agent in --agents: gpt9. Expected one of codex, claude,',
      )
      await expect(failure(['--agents', 'codex', 'task'])).resolves.toContain(
        '--agents needs at least two agents',
      )
      await expect(failure(['--agents', 'codex,claude,CODEX', 'task'])).resolves.toContain(
        '--agents lists codex more than once',
      )
    })

    it('rejects an invalid model override', async () => {
      for (const value of ['gpt-x', '=gpt-x', 'codex=', 'codex= ']) {
        await expect(failure(['--model', value, 'task'])).resolves.toContain(
          `Invalid --model value: ${value}. Expected <agent>=<model>.`,
        )
      }
      await expect(failure(['--model', 'gpt9=x', 'task'])).resolves.toContain(
        'Unknown agent in --model: gpt9',
      )
      await expect(failure(['--model', 'glm=glm-5', 'task'])).resolves.toContain(
        '--model sets glm, which is not one of the --agents',
      )
    })

    it('rejects an invalid effort override', async () => {
      await expect(failure(['--effort', 'low', 'task'])).resolves.toContain(
        'Invalid --effort value: low. Expected <agent>=<effort>.',
      )
      await expect(failure(['--effort', 'glm=low', 'task'])).resolves.toContain(
        '--effort sets glm, which is not one of the --agents',
      )
      await expect(
        failure(['--agents', 'codex,deepseek', '--effort', 'deepseek=low', 'task']),
      ).resolves.toContain('DeepSeek does not take --effort')
    })

    it('rejects an unknown option', async () => {
      await expect(failure(['--nope'])).resolves.toMatch(/^jev-planner: Unknown option '--nope'/)
    })

    it('reports a non-Error failure', async () => {
      const h = harness({ createPlanner: () => ({ plan: () => rejectWith('planner down') }) })
      await expect(main(['task'], h.deps)).resolves.toBe(1)
      expect(h.stderr()).toBe(
        `[jev-planner] Writing rounds to ${join(dir, '.jev-planner', RUN)}\n` +
          'jev-planner: planner down\n',
      )
    })
  })
})
