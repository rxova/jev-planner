import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { costLine, createAgents, helpText, main } from './cli.js'
import { PROVIDERS } from '../providers/providers.js'
import type { CliDeps, PlannerProgram } from './cli.types.js'
import type { CheckResult } from '../doctor/doctor.types.js'
import type { Verdict } from '../questions/questions.types.js'
import type {
  PlanCost,
  PlanOptions,
  PlanResult,
  PlanRound,
} from '../orchestrator/orchestrator.types.js'

/** A program shaped like jev-planner, so the expectations read like its output. */
const program: PlannerProgram = {
  name: 'jev-planner',
  version: '1.2.3',
  summary: 'collaborative coding plans from two or more agents, judged by Jev',
  judge: 'Jev',
  judgeModelDefault: "SDK's jev-latest",
  judgeEnv: [
    {
      variable: 'TYPESAFE_API_KEY',
      check: 'TypeSafe key',
      missing:
        'TYPESAFE_API_KEY is not set. Create a key at https://console.typesafe.ai/keys and export it first.',
    },
  ],
}

const HELP = helpText(program)

/** A rejection with a non-Error reason: what the `String(error)` fallback is for. */
function rejectWith(reason: unknown): Promise<never> {
  // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the point of the test
  return Promise.reject(reason)
}

const verdict: Verdict = {
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
  standsAloneProbability: 0.2,
  model: 'jev-test',
}

const cost: PlanCost = {
  mode: 'balanced',
  reviewMode: 'standard',
  reviewRounds: 0,
  synthesized: true,
  agentCalls: 3,
  judgeCalls: 1,
  dropped: [],
}

const result: PlanResult = {
  plan: '  # The plan  \n',
  verdict,
  finalizer: 'codex',
  drafts: { codex: 'codex draft', claude: 'claude draft' },
  timings: { totalMs: 312_000, rounds: [] },
  cost,
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
      setup = { agents: agents.map(({ name }) => name), models, efforts }
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
    program,
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
    expect(h.stdout()).toBe(`${program.version}\n`)
  })

  it('plans a task given as arguments, with defaults', async () => {
    const h = harness()
    await expect(main(['Add', 'caching'], h.deps)).resolves.toBe(0)
    expect(h.planned()).toMatchObject({
      task: 'Add caching',
      cwd: dir,
      timeoutMs: 600_000,
      mode: 'balanced',
      maxReviewRounds: 2,
    })
    expect(h.planned()).not.toHaveProperty('judgeModel')
    expect(h.planned()).not.toHaveProperty('finalizer')
    expect(h.planned()).not.toHaveProperty('allowAnyTask')
    expect(h.planned()).not.toHaveProperty('stragglerGraceMs')
    expect(h.setup()).toEqual({ agents: ['codex', 'claude'], models: {}, efforts: {} })
    expect(h.stdout()).toBe('# The plan\n')
    expect(h.stderr()).toBe(
      `[jev-planner] Writing rounds to ${join(dir, '.jev-planner', RUN)}\n[jev-planner] Drafting…\n[jev-planner] ${costLine(cost, 'Jev')}\n`,
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
        '--judge-model',
        'jev-custom',
        '--finalizer',
        'claude',
        '--mode',
        'balanced',
        '--review-rounds',
        '1',
        '--straggler-grace',
        '30',
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
      mode: 'balanced',
      maxReviewRounds: 1,
      stragglerGraceMs: 30_000,
      judgeModel: 'jev-custom',
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

  it('runs the full pipeline with --mode ultra, which takes no straggler grace', async () => {
    const h = harness()
    await expect(main(['--mode', 'ultra', 'task'], h.deps)).resolves.toBe(0)
    expect(h.planned()).toMatchObject({ mode: 'ultra' })
    expect(h.planned()).not.toHaveProperty('stragglerGraceMs')
  })

  it('passes --mode fast with a straggler grace', async () => {
    const h = harness()
    await expect(main(['--mode', 'fast', '--straggler-grace', '30', 'task'], h.deps)).resolves.toBe(
      0,
    )
    expect(h.planned()).toMatchObject({ mode: 'fast', stragglerGraceMs: 30_000 })
  })

  it('says a fast run that took a draft whole selected it, and a merged one merged', () => {
    const fast = {
      mode: 'fast' as const,
      reviewMode: 'standard' as const,
      reviewRounds: 0,
      agentCalls: 2,
      judgeCalls: 1,
    }
    expect(costLine({ ...fast, synthesized: false, dropped: ['codex'] }, 'Jev')).toBe(
      'fast mode, 2 agent calls, 1 Jev call, 0 cross-review rounds, selected, not waited for: codex',
    )
    expect(
      costLine({ ...fast, agentCalls: 3, judgeCalls: 3, synthesized: true, dropped: [] }, 'Jev'),
    ).toBe('fast mode, 3 agent calls, 3 Jev calls, 0 cross-review rounds, merged')
  })

  it('reports what the run cost on stderr, singular and plural', () => {
    expect(costLine(cost, 'Jev')).toBe(
      'balanced mode, 3 agent calls, 1 Jev call, 0 cross-review rounds, merged',
    )
    expect(
      costLine(
        {
          mode: 'ultra',
          reviewMode: 'standard',
          reviewRounds: 1,
          synthesized: false,
          agentCalls: 1,
          judgeCalls: 2,
          dropped: ['glm'],
        },
        'Jev',
      ),
    ).toBe(
      'ultra mode, 1 agent call, 2 Jev calls, 1 cross-review round, adopted whole, not waited for: glm',
    )
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
      cost,
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
      'jev-planner: Missing coding task. Pass it as an argument, with --file, on stdin, or as task in the config file.\n',
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
        timings: { totalMs: 65_000, agents: { codex: 58_000, claude: 41_000 }, judgeMs: 7_000 },
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
      expect(JSON.parse(await read('round2/verdict.json'))).toEqual(verdict)
      await expect(read('final/plan.md')).resolves.toBe('<!-- merged by codex -->\nmerged\n')
      await expect(read('final/verdict.json')).resolves.toContain('"finalizer": "codex"')
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

    it('prints how long each round and call took with --verbose, even with --no-rounds', async () => {
      const h = harness(replaying())
      await expect(main(['--verbose', '--no-rounds', 'task'], h.deps)).resolves.toBe(0)
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
      {
        round: 1,
        stage: 'draft',
        plans: { codex: 'codex draft', claude: 'claude draft' },
        timings: { totalMs: 1_000, agents: { codex: 1_000, claude: 900 } },
      },
      {
        round: 2,
        stage: 'final',
        plans: { codex: 'merged' },
        verdict,
        timings: { totalMs: 500, agents: { codex: 500 } },
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
      expect(h.stdout()).toBe('✓ Codex CLI: detail\n✓ TypeSafe key: TYPESAFE_API_KEY is set\n')
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
        '--review-rounds must be 0, 1 or 2',
      )
      await expect(failure(['--timeout', '0', 'task'])).resolves.toContain(
        '--timeout must be a positive number',
      )
      await expect(failure(['--timeout', 'soon', 'task'])).resolves.toContain(
        '--timeout must be a positive number',
      )
      await expect(failure(['--mode', 'turbo', 'task'])).resolves.toContain(
        'Invalid --mode value: turbo. Expected fast, balanced or ultra.',
      )
      await expect(failure(['--straggler-grace=-1', 'task'])).resolves.toContain(
        '--straggler-grace must be a number of seconds, 0 or more',
      )
      await expect(failure(['--straggler-grace', 'soon', 'task'])).resolves.toContain(
        '--straggler-grace must be a number of seconds, 0 or more',
      )
      await expect(
        failure(['--mode', 'ultra', '--straggler-grace', '30', 'task']),
      ).resolves.toContain('--straggler-grace is for --mode balanced or fast')
      await expect(
        failure(['--mode', 'fast', '--review-mode', 'debate', 'task']),
      ).resolves.toContain('--review-mode debate needs a review round, and --mode fast has none')
      await expect(failure(['--mode', 'fast', '--claim-checks', 'task'])).resolves.toContain(
        '--claim-checks needs a review round, and --mode fast has none',
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

describe('the debate review', () => {
  it('passes --review-mode and --claim-checks through, and neither by default', async () => {
    const plain = harness()
    await main(['task'], plain.deps)
    expect(plain.planned()).not.toHaveProperty('reviewMode')
    expect(plain.planned()).not.toHaveProperty('claimChecks')

    const debate = harness()
    await expect(main(['--review-mode', 'debate', 'task'], debate.deps)).resolves.toBe(0)
    expect(debate.planned()).toMatchObject({ reviewMode: 'debate' })
    expect(debate.planned()).not.toHaveProperty('claimChecks')

    const checked = harness()
    await expect(
      main(['--claim-checks', '--review-rounds', '1', 'task'], checked.deps),
    ).resolves.toBe(0)
    expect(checked.planned()).toMatchObject({
      reviewMode: 'debate',
      claimChecks: true,
      maxReviewRounds: 1,
    })

    const standard = harness()
    await expect(main(['--review-mode', 'standard', 'task'], standard.deps)).resolves.toBe(0)
    expect(standard.planned()).not.toHaveProperty('reviewMode')
  })

  it.each([
    [['--review-mode', 'loud'], 'Invalid --review-mode value: loud. Expected standard or debate.'],
    [
      ['--review-mode', 'standard', '--claim-checks'],
      '--claim-checks runs in the debate review; drop --review-mode standard',
    ],
    [
      ['--review-mode', 'debate', '--review-rounds', '0'],
      '--review-mode debate is a review round; it needs --review-rounds 1 or 2',
    ],
    [
      ['--claim-checks', '--review-rounds', '0'],
      '--review-mode debate is a review round; it needs --review-rounds 1 or 2',
    ],
  ])('rejects %j before planning', async (args, message) => {
    const h = harness()
    await expect(main([...args, '--no-rounds', 'task'], h.deps)).resolves.toBe(1)
    expect(h.stderr()).toBe(`jev-planner: ${message}\n`)
    expect(h.planned()).toBeUndefined()
  })

  it('documents both flags in the help', () => {
    expect(HELP).toContain('--review-mode <standard|debate>')
    expect(HELP).toContain('--claim-checks')
  })

  it('names the debate review in the cost line only when it ran', () => {
    expect(costLine({ ...cost, reviewMode: 'debate' }, 'Jev')).toBe(
      'balanced mode, debate review, 3 agent calls, 1 Jev call, 0 cross-review rounds, merged',
    )
  })

  const objection = {
    id: 'codex:claude:C1',
    critic: 'codex',
    target: 'claude',
    claim: 'x',
    why: 'y',
    repo: true,
  }
  const reply = {
    id: 'codex:claude:C1',
    author: 'claude',
    decision: 'reject',
    reason: 'no',
  } as const
  const dispute = {
    id: 'D1',
    target: 'claude',
    critics: ['codex'],
    objections: ['codex:claude:C1'],
    claim: 'x',
    reasons: ['y'],
    rejections: ['no'],
    repo: true,
  }
  const timings = { totalMs: 1, agents: {} }
  const plans = { codex: 'codex plan', claude: 'claude plan' }
  const debateRounds = (withChecks: boolean): PlanRound[] => [
    {
      round: 1,
      stage: 'critique',
      plans,
      artifacts: { codex: 'TARGET: claude\nC1 [repo]: x — y', claude: 'nothing' },
      debate: { objections: [objection] },
      timings,
    },
    {
      round: 2,
      stage: withChecks ? 'reply' : 'review',
      plans,
      artifacts: { claude: 'codex:claude:C1: reject — no' },
      debate: {
        objections: [objection],
        replies: [reply],
        disputes: [dispute],
        ...(withChecks ? {} : { claimChecks: 'skipped' as const }),
      },
      ...(withChecks ? {} : { verdict }),
      timings,
    },
    ...(withChecks
      ? [
          {
            round: 3,
            stage: 'check' as const,
            plans,
            artifacts: { codex: 'D1: confirm — src/a.ts' },
            debate: {
              objections: [objection],
              replies: [reply],
              unanswered: [],
              disputes: [
                {
                  ...dispute,
                  check: { checker: 'codex', result: 'confirm' as const, evidence: 'src/a.ts' },
                },
              ],
              overflow: [],
              claimChecks: 'ran' as const,
            },
            verdict,
            timings,
          },
        ]
      : []),
  ]
  const replay = (rounds: PlanRound[]): Partial<CliDeps> => ({
    createPlanner: () => ({
      plan: async (options) => {
        for (const round of rounds) await options.onRound?.(round)
        return { ...result, debate: rounds.at(-1)?.debate ?? { objections: [] } }
      },
    }),
  })

  it('writes the critiques, replies and checks beside the plans, with what was parsed from them', async () => {
    const h = harness(replay(debateRounds(true)))
    await expect(main(['--rounds-dir', 'out', '--verbose', 'task'], h.deps)).resolves.toBe(0)
    const read = (path: string) => readFile(join(dir, 'out', path), 'utf8')

    await expect(readdir(join(dir, 'out/round1'))).resolves.toEqual([
      'claude.critique.md',
      'codex.critique.md',
      'objections.json',
      'timings.json',
    ])
    expect(JSON.parse(await read('round1/objections.json'))).toEqual([objection])
    await expect(readdir(join(dir, 'out/round2'))).resolves.toEqual([
      'claude.md',
      'claude.reply.md',
      'codex.md',
      'disputes.json',
      'replies.json',
      'timings.json',
    ])
    expect(JSON.parse(await read('round2/replies.json'))).toEqual({
      replies: [reply],
      unanswered: [],
    })
    expect(JSON.parse(await read('round2/disputes.json'))).toEqual({
      disputes: [dispute],
      overflow: [],
    })
    await expect(readdir(join(dir, 'out/round3'))).resolves.toEqual([
      'codex.check.md',
      'disputes.json',
      'replies.json',
      'timings.json',
      'verdict.json',
    ])
    expect(JSON.parse(await read('round3/disputes.json'))).toMatchObject({ claimChecks: 'ran' })
    expect(h.stderr()).toContain('[jev-planner] Critiques: 0.0s\n')
    expect(h.stderr()).toContain('[jev-planner] Replies: 0.0s\n')
    expect(h.stderr()).toContain('[jev-planner] Claim checks: 0.0s\n')
  })

  it('writes a review round’s replies as .reply.md, and the debate in the JSON output', async () => {
    const h = harness(replay(debateRounds(false)))
    await expect(main(['--rounds-dir', 'out', '--json', 'task'], h.deps)).resolves.toBe(0)
    await expect(readdir(join(dir, 'out/round2'))).resolves.toContain('claude.reply.md')
    expect(JSON.parse(await readFile(join(dir, 'out/round2/disputes.json'), 'utf8'))).toMatchObject(
      { claimChecks: 'skipped' },
    )
    expect(JSON.parse(h.stdout())).toMatchObject({ debate: { disputes: [dispute] } })
  })
})

describe('the config file', () => {
  /** Writes `settings` as `jev-planner.json` in `folder`, the harness's working directory by default. */
  async function config(settings: unknown, folder = dir, name = 'jev-planner.json') {
    await mkdir(folder, { recursive: true })
    const path = join(folder, name)
    await writeFile(path, JSON.stringify(settings))
    return path
  }

  it('reads jev-planner.json from the working directory, and says so', async () => {
    const path = await config({
      agents: { codex: { model: 'gpt-x', effort: 'low', reviewEffort: 'high' }, glm: {} },
      mode: 'ultra',
      reviewMode: 'debate',
      reviewRounds: 1,
      claimChecks: true,
      finalizer: 'none',
      judgeModel: 'jev-custom',
      timeout: 1.5,
      resume: false,
      allowAnyTask: true,
      task: 'TODO',
    })
    const h = harness()
    await expect(main([], h.deps)).resolves.toBe(0)
    expect(h.setup()).toEqual({
      agents: ['codex', 'glm'],
      models: { codex: 'gpt-x' },
      efforts: { codex: 'low' },
    })
    expect(h.planned()).toMatchObject({
      task: 'TODO',
      mode: 'ultra',
      maxReviewRounds: 1,
      reviewMode: 'debate',
      claimChecks: true,
      selectStronger: true,
      judgeModel: 'jev-custom',
      timeoutMs: 1_500,
      resume: false,
      allowAnyTask: true,
      reviewEfforts: { codex: 'high' },
    })
    expect(h.stderr()).toMatch(new RegExp(`^\\[jev-planner\\] Using config ${path}\n`))
  })

  it('lets every flag given on the command line beat the config', async () => {
    await config({
      agents: { codex: { model: 'gpt-x', effort: 'low' }, claude: { model: 'opus' } },
      mode: 'ultra',
      finalizer: 'claude',
      timeout: 5,
      stragglerGrace: 10,
      claimChecks: true,
      resume: false,
      json: true,
      verbose: true,
      allowAnyTask: true,
    })
    const h = harness()
    const code = await main(
      [
        ...['--mode', 'balanced', '--finalizer', 'auto', '--timeout', '9', '-m', 'codex=gpt-y'],
        ...['--no-claim-checks', '--resume', '--no-json', '--no-verbose', '--no-allow-any-task'],
        'Add caching',
      ],
      h.deps,
    )
    expect(code).toBe(0)
    expect(h.setup()).toEqual({
      agents: ['codex', 'claude'],
      models: { codex: 'gpt-y', claude: 'opus' },
      efforts: { codex: 'low' },
    })
    expect(h.planned()).toMatchObject({
      mode: 'balanced',
      timeoutMs: 9_000,
      stragglerGraceMs: 10_000,
    })
    for (const key of ['finalizer', 'claimChecks', 'resume', 'allowAnyTask', 'onAgentProgress']) {
      expect(h.planned()).not.toHaveProperty(key)
    }
    expect(h.stdout()).toBe('# The plan\n')
  })

  it('turns on with a flag what the config leaves off', async () => {
    await config({ json: false, verbose: false, claimChecks: false, allowAnyTask: false })
    const h = harness()
    await main(['--json', '--verbose', '--claim-checks', '--allow-any-task', 'TODO'], h.deps)
    expect(h.planned()).toMatchObject({ claimChecks: true, allowAnyTask: true })
    expect(h.planned()).toHaveProperty('onAgentProgress')
    expect(JSON.parse(h.stdout())).toHaveProperty('plan')
  })

  it('drops the config’s settings for agents that --agents leaves out', async () => {
    await config({ agents: { codex: { model: 'gpt-x' }, deepseek: { model: 'ds' } } })
    const h = harness()
    await main(['--agents', 'codex,claude', 'task'], h.deps)
    expect(h.setup()).toEqual({
      agents: ['codex', 'claude'],
      models: { codex: 'gpt-x' },
      efforts: {},
    })
  })

  it('looks for the config in the --cwd repository', async () => {
    const repo = join(dir, 'repo')
    await config({ mode: 'fast' }, repo)
    await config({ mode: 'ultra' })
    const h = harness()
    await main(['-C', 'repo', 'task'], h.deps)
    expect(h.planned()).toMatchObject({ cwd: repo, mode: 'fast' })
  })

  it('reads --config relative to the working directory, and lets it set cwd', async () => {
    const repo = join(dir, 'repo')
    await mkdir(repo)
    await config({ mode: 'ultra' })
    await config({ cwd: '../repo', mode: 'fast', output: 'PLAN.md' }, join(dir, 'setup'), 'x.json')
    const h = harness()
    await expect(main(['--config', 'setup/x.json', 'task'], h.deps)).resolves.toBe(0)
    expect(h.planned()).toMatchObject({ cwd: repo, mode: 'fast' })
    await expect(readFile(join(dir, 'setup', 'PLAN.md'), 'utf8')).resolves.toBe('# The plan\n')
    await main(['-c', 'setup/x.json', '-C', '.', 'task'], h.deps)
    expect(h.planned()).toMatchObject({ cwd: dir })
  })

  it('reads no config with --no-config, even a broken one', async () => {
    await writeFile(join(dir, 'jev-planner.json'), '{')
    const h = harness()
    await expect(main(['--no-config', 'task'], h.deps)).resolves.toBe(0)
    expect(h.stderr()).not.toContain('Using config')
  })

  it('shows help and the version whatever the config holds', async () => {
    await writeFile(join(dir, 'jev-planner.json'), '{')
    await expect(main(['--help'], harness().deps)).resolves.toBe(0)
    await expect(main(['--version'], harness().deps)).resolves.toBe(0)
  })

  it('takes the task from the config when none is given, and from its taskFile', async () => {
    await config({ task: 'Add caching' })
    const h = harness({ readStdin: () => Promise.resolve('') })
    await main([], h.deps)
    expect(h.planned()?.task).toBe('Add caching')
    await mkdir(join(dir, 'setup'))
    await writeFile(join(dir, 'setup', 'TASK.md'), ' Add a cache \n')
    await config({ taskFile: 'TASK.md' }, join(dir, 'setup'))
    await main(['-C', 'setup'], h.deps)
    expect(h.planned()?.task).toBe('Add a cache')
  })

  it('lets a task on the command line beat the config’s, without reading stdin', async () => {
    await config({ task: 'Add caching' })
    const readStdin = vi.fn(() => Promise.resolve('piped'))
    const h = harness({ readStdin })
    await main(['plan', 'Add', 'paging'], h.deps)
    expect(h.planned()?.task).toBe('Add paging')
    await writeFile(join(dir, 'task.md'), 'Add search')
    await main(['-f', 'task.md'], h.deps)
    expect(h.planned()?.task).toBe('Add search')
    expect(readStdin).not.toHaveBeenCalled()
  })

  it('rejects a piped task when the config has one too, before anything is billed', async () => {
    await config({ task: 'Add caching' })
    const createPlanner = vi.fn()
    const h = harness({ readStdin: () => Promise.resolve(' Add paging\n'), createPlanner })
    await expect(main([], h.deps)).resolves.toBe(1)
    expect(h.stderr()).toContain(
      "jev-planner: The task is piped on stdin and set in the config. Pass the task as an argument or with --file to override the config's task.\n",
    )
    expect(createPlanner).not.toHaveBeenCalled()
  })

  it('still takes a piped task when the config has none', async () => {
    await config({ mode: 'fast' })
    const h = harness({ readStdin: () => Promise.resolve('Add paging') })
    await main([], h.deps)
    expect(h.planned()?.task).toBe('Add paging')
  })

  it('reports a taskFile that is not there, with its path', async () => {
    await config({ taskFile: 'TASK.md' })
    const h = harness()
    await expect(main([], h.deps)).resolves.toBe(1)
    expect(h.stderr()).toContain(join(dir, 'TASK.md'))
  })

  it('gives each run its own folder under runsDir, so the second run works too', async () => {
    await config({ runsDir: 'runs', task: 'Add caching' })
    const h = harness()
    await expect(main([], h.deps)).resolves.toBe(0)
    await expect(main([], h.deps)).resolves.toBe(0)
    expect((await readdir(join(dir, 'runs'))).sort()).toEqual(['.gitignore', RUN, `${RUN}-2`])
    await expect(readdir(join(dir, '.jev-planner'))).rejects.toThrow('ENOENT')
  })

  it('lets --rounds-dir and --no-rounds beat runsDir, and --rounds beat rounds: false', async () => {
    await config({ runsDir: 'runs' })
    const h = harness()
    await main(['--rounds-dir', 'exact', 'task'], h.deps)
    await main(['--no-rounds', 'task'], h.deps)
    await expect(readdir(join(dir, 'runs'))).rejects.toThrow('ENOENT')
    await expect(readdir(join(dir, 'exact'))).resolves.toEqual([])

    await config({ rounds: false })
    await main(['task'], h.deps)
    await expect(readdir(join(dir, '.jev-planner'))).rejects.toThrow('ENOENT')
    await main(['--rounds', 'task'], h.deps)
    await expect(readdir(join(dir, '.jev-planner'))).resolves.toContain(RUN)
  })

  it('runs doctor with the configured agents and repository, never reading stdin', async () => {
    const repo = join(dir, 'repo')
    await mkdir(repo)
    const path = await config(
      { cwd: repo, agents: { deepseek: {}, kimi: {} }, task: 'x' },
      dir,
      'x.json',
    )
    const doctor = vi.fn<CliDeps['doctor']>(() => Promise.resolve([]))
    const readStdin = vi.fn(() => Promise.resolve('piped'))
    await expect(
      main(['doctor', '--config', path], harness({ doctor, readStdin }).deps),
    ).resolves.toBe(0)
    expect(doctor.mock.calls[0]?.[0]).toBe(repo)
    expect(doctor.mock.calls[0]?.[1].map(({ id }) => id)).toEqual(['deepseek', 'kimi'])
    expect(readStdin).not.toHaveBeenCalled()
  })

  describe('errors', () => {
    async function failure(argv: string[]): Promise<string> {
      const h = harness()
      await expect(main(argv, h.deps)).resolves.toBe(1)
      expect(h.planned()).toBeUndefined()
      return h.stderr()
    }

    it('reports a config that is not valid, naming the file and the key', async () => {
      const path = await config({ mode: 'slow' })
      await expect(failure(['task'])).resolves.toBe(
        `jev-planner: ${path}: mode: must be one of "fast", "balanced", "ultra"\n`,
      )
    })

    it('reports a --config file that is not there', async () => {
      await expect(failure(['--config', 'missing.json', 'task'])).resolves.toContain(
        `Cannot read the config ${join(dir, 'missing.json')}`,
      )
    })

    it('rejects --config with --no-config, and a flag with its --no- form', async () => {
      await expect(failure(['--config', 'x.json', '--no-config', 'task'])).resolves.toBe(
        'jev-planner: Pass --config or --no-config, not both\n',
      )
      for (const name of [
        'json',
        'verbose',
        'resume',
        'rounds',
        'claim-checks',
        'allow-any-task',
      ]) {
        await expect(failure([`--${name}`, `--no-${name}`, 'task'])).resolves.toBe(
          `jev-planner: Pass --${name} or --no-${name}, not both\n`,
        )
      }
    })

    it('rejects --no- on a flag that takes a value', async () => {
      await expect(failure(['--no-cwd', 'task'])).resolves.toContain("Unknown option '--no-cwd'")
    })

    it('checks the config’s values against each other and the flags, as flags', async () => {
      await config({ mode: 'ultra', stragglerGrace: 5 })
      await expect(failure(['task'])).resolves.toContain(
        '--straggler-grace is for --mode balanced or fast',
      )
      await config({ agents: { codex: {}, claude: {} }, finalizer: 'glm' })
      await expect(failure(['task'])).resolves.toContain('Invalid --finalizer value: glm')
    })
  })
})

describe('several agents from one provider', () => {
  async function failure(argv: string[]): Promise<string> {
    const h = harness()
    await expect(main(argv, h.deps)).resolves.toBe(1)
    expect(h.planned()).toBeUndefined()
    return h.stderr()
  }

  const TWO = ['--agents', 'codex:sol,codex:terra']

  it('names each agent after the colon, lowercased, and a bare provider after itself', async () => {
    const h = harness()
    await main(['--agents', 'codex:Sol, codex:terra ,claude', 'task'], h.deps)
    expect(h.setup()?.agents).toEqual(['sol', 'terra', 'claude'])
  })

  it('takes overrides and the finalizer by name', async () => {
    const h = harness()
    await main(
      [
        ...TWO,
        '--model',
        'sol=gpt-a',
        '--model',
        'TERRA=gpt-b',
        '--effort',
        'sol=high',
        '--review-effort',
        'terra=low',
        '--finalizer',
        'Terra',
        'task',
      ],
      h.deps,
    )
    expect(h.setup()).toEqual({
      agents: ['sol', 'terra'],
      models: { sol: 'gpt-a', terra: 'gpt-b' },
      efforts: { sol: 'high' },
    })
    expect(h.planned()).toMatchObject({ finalizer: 'terra', reviewEfforts: { terra: 'low' } })
  })

  it('rejects a list that names nobody twice apart, with a hint for a repeated provider', async () => {
    await expect(failure(['--agents', 'codex,codex', 'task'])).resolves.toContain(
      '--agents lists codex more than once; name each instance: codex:a,codex:b',
    )
    await expect(failure(['--agents', 'codex:Sol,codex:sol', 'task'])).resolves.toContain(
      'jev-planner: --agents lists sol more than once\n',
    )
    await expect(failure(['--agents', 'codex:codex,codex', 'task'])).resolves.toContain(
      '--agents lists codex more than once; name each instance',
    )
  })

  it('rejects a name the run cannot use', async () => {
    await expect(failure(['--agents', 'codex:claude,claude', 'task'])).resolves.toContain(
      'claude: the name of another provider, not an agent name',
    )
    await expect(failure(['--agents', 'codex:tie,claude', 'task'])).resolves.toContain(
      'tie: a reserved word, not an agent name',
    )
    await expect(failure(['--agents', 'codex:con,claude', 'task'])).resolves.toContain(
      'con: a reserved word, not an agent name',
    )
    await expect(failure(['--agents', 'codex:,claude', 'task'])).resolves.toContain(
      ': an agent name is a letter, then letters, digits or -, at most 24 characters',
    )
    await expect(failure(['--agents', 'codex:a:b,claude', 'task'])).resolves.toContain(
      'Invalid agent in --agents: codex:a:b. Expected <provider>[:<name>].',
    )
    await expect(failure(['--agents', 'gpt9:sol,claude', 'task'])).resolves.toContain(
      'Unknown agent in --agents: gpt9.',
    )
  })

  it('asks which instance a provider id meant, and names the run’s agents otherwise', async () => {
    await expect(failure([...TWO, '--model', 'codex=x', 'task'])).resolves.toContain(
      "--model codex: the run's Codex agents are sol, terra; name one",
    )
    await expect(failure([...TWO, '--model', 'claude=x', 'task'])).resolves.toContain(
      '--model sets claude, which is not one of the --agents',
    )
    await expect(failure([...TWO, '--effort', 'luna=x', 'task'])).resolves.toContain(
      'Unknown agent in --effort: luna. Expected one of sol, terra.',
    )
    await expect(failure([...TWO, '--finalizer', 'codex', 'task'])).resolves.toContain(
      'Invalid --finalizer value: codex. Expected auto, none or one of sol, terra.',
    )
  })

  it('warns when two agents of one provider would draft alike, whatever their review effort', async () => {
    const h = harness()
    await main([...TWO, '--review-effort', 'sol=low', 'task'], h.deps)
    expect(h.stderr()).toContain(
      '[jev-planner] sol and terra are both Codex with the same model and effort; their drafts may barely differ. Vary --model or --effort.\n',
    )
    const three = harness()
    await main(['--agents', 'codex:a,codex:b,codex:c', 'task'], three.deps)
    expect(three.stderr()).toContain('a, b and c are all Codex with the same model')
    expect(three.planned()).toBeDefined()
  })

  it('does not warn when the model or the effort differs, or the providers do', async () => {
    for (const argv of [
      [...TWO, '--effort', 'sol=high'],
      [...TWO, '--model', 'terra=gpt-b'],
      ['--agents', 'codex:sol,claude:terra'],
    ]) {
      const h = harness()
      await main([...argv, 'task'], h.deps)
      expect(h.stderr()).not.toContain('drafts may barely differ')
    }
  })

  it('checks each provider once in doctor', async () => {
    const doctor = vi.fn<CliDeps['doctor']>(() => Promise.resolve([]))
    await main(['doctor', '--agents', 'codex:a,codex:b,claude'], harness({ doctor }).deps)
    expect(doctor.mock.calls[0]?.[1].map(({ id }) => id)).toEqual(['codex', 'claude'])
  })

  it('keeps a config’s settings for a name only while it names the same provider', async () => {
    await writeFile(
      join(dir, 'jev-planner.json'),
      JSON.stringify({
        agents: {
          sol: { provider: 'codex', model: 'gpt-a', effort: 'high' },
          terra: { provider: 'codex', model: 'gpt-b' },
        },
      }),
    )
    const same = harness()
    await main(['task'], same.deps)
    expect(same.setup()).toEqual({
      agents: ['sol', 'terra'],
      models: { sol: 'gpt-a', terra: 'gpt-b' },
      efforts: { sol: 'high' },
    })
    const moved = harness()
    await main(['--agents', 'claude:sol,codex:terra', 'task'], moved.deps)
    expect(moved.setup()).toEqual({
      agents: ['sol', 'terra'],
      models: { terra: 'gpt-b' },
      efforts: {},
    })
  })

  it('documents the named form in the help', () => {
    expect(HELP).toContain('-a, --agents <provider[:name],…>')
    expect(HELP).toContain('as codex:sol,codex:terra')
    expect(HELP).toContain('-m, --model <name>=<model>')
    expect(HELP).toContain('--finalizer <name>')
  })

  it('creates each agent under its name and label, with its own overrides', () => {
    const codex = PROVIDERS.find(({ id }) => id === 'codex')
    if (!codex) throw new Error('no codex provider')
    const agents = createAgents(
      {
        agents: [
          { name: 'sol', label: 'Codex (sol)', provider: codex },
          { name: 'terra', label: 'Codex (terra)', provider: codex },
        ],
        models: { sol: 'gpt-a' },
        efforts: { terra: 'high' },
      },
      {},
      [],
    )
    expect(agents.map(({ name, label }) => [name, label])).toEqual([
      ['sol', 'Codex (sol)'],
      ['terra', 'Codex (terra)'],
    ])
  })
})
