import { readFile, stat, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import packageJson from '../package.json' with { type: 'json' }
import type { CheckResult } from './doctor.js'
import { requireNonEmptyTask, validateTask } from './task.js'
import type { AgentName, PlanOptions, PlanResult } from './types.js'

export const VERSION: string = packageJson.version

export const HELP = `jev-planner — collaborative coding plans from Codex, Claude, and Jev

Usage:
  jev-planner [plan] [options] "<coding task>"
  jev-planner doctor [--cwd <directory>]

Options:
  -C, --cwd <directory>       Repository to inspect (default: current directory)
  -f, --file <path>           Read the coding task from a UTF-8 file
  -o, --output <path>         Write the final plan to a file instead of stdout
      --codex-model <model>   Override the Codex CLI model
      --claude-model <model>  Override the Claude Code model
      --jev-model <model>     Override Jev (default: SDK's jev-latest)
      --finalizer <agent>     auto, codex, or claude (default: auto/Jev decides)
      --review-rounds <1|2>   Maximum cross-review rounds (default: 2)
      --timeout <seconds>     Timeout for each agent call (default: 600)
      --json                  Emit plan metadata as JSON
      --verbose               Print Jev's typed verdict to stderr
      --allow-any-task        Plan the task even if it looks like a placeholder
  -h, --help                  Show help
  -v, --version               Show version

The task can also be piped on stdin. Codex and Claude use their existing CLI logins.
Jev requires TYPESAFE_API_KEY.`

/** The planner surface the CLI drives; `Planner` in production, a fake in tests. */
export interface PlanRunner {
  plan(options: PlanOptions): Promise<PlanResult>
}

/** Model overrides from the command line, handed to the planner factory. */
export interface ModelOverrides {
  codexModel?: string
  claudeModel?: string
}

/** Everything `main` touches outside its arguments, so tests can replace it. */
export interface CliDeps {
  stdout: (text: string) => void
  stderr: (text: string) => void
  env: Readonly<Record<string, string | undefined>>
  cwd: () => string
  /** The piped task, or `undefined` when stdin is a terminal. */
  readStdin: () => Promise<string | undefined>
  createPlanner: (models: ModelOverrides) => PlanRunner
  doctor: (cwd: string) => Promise<CheckResult[]>
}

async function assertDirectory(path: string): Promise<void> {
  const info = await stat(path).catch(() => undefined)
  if (!info?.isDirectory()) throw new Error(`Not a directory: ${path}`)
}

function parseFinalizer(value: string | undefined): AgentName | undefined {
  if (value === undefined || value === 'auto') return undefined
  if (value === 'codex' || value === 'claude') return value
  throw new Error(`Invalid --finalizer value: ${value}. Expected auto, codex, or claude.`)
}

function parseTimeout(value: string | undefined): number {
  const seconds = Number(value ?? '600')
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error('--timeout must be a positive number of seconds')
  }
  return Math.round(seconds * 1_000)
}

function parseReviewRounds(value: string | undefined): 1 | 2 {
  if (value === undefined || value === '2') return 2
  if (value === '1') return 1
  throw new Error('--review-rounds must be 1 or 2')
}

function parse(argv: readonly string[]) {
  return parseArgs({
    args: [...argv],
    allowPositionals: true,
    strict: true,
    options: {
      cwd: { type: 'string', short: 'C' },
      file: { type: 'string', short: 'f' },
      output: { type: 'string', short: 'o' },
      'codex-model': { type: 'string' },
      'claude-model': { type: 'string' },
      'jev-model': { type: 'string' },
      finalizer: { type: 'string' },
      'review-rounds': { type: 'string' },
      timeout: { type: 'string' },
      json: { type: 'boolean', default: false },
      verbose: { type: 'boolean', default: false },
      'allow-any-task': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
      version: { type: 'boolean', short: 'v', default: false },
    },
  })
}

async function run(argv: readonly string[], deps: CliDeps): Promise<number> {
  const { values, positionals } = parse(argv)

  if (values.help) {
    deps.stdout(`${HELP}\n`)
    return 0
  }
  if (values.version) {
    deps.stdout(`${VERSION}\n`)
    return 0
  }

  const cwd = resolve(deps.cwd(), values.cwd ?? '.')
  await assertDirectory(cwd)

  if (positionals[0] === 'doctor') {
    if (positionals.length > 1) throw new Error('doctor does not accept a task')
    const checks = await deps.doctor(cwd)
    for (const check of checks) {
      deps.stdout(`${check.ok ? '✓' : '✗'} ${check.name}: ${check.detail}\n`)
    }
    return checks.every((check) => check.ok) ? 0 : 1
  }

  const taskPositionals = positionals[0] === 'plan' ? positionals.slice(1) : positionals
  if (values.file !== undefined && taskPositionals.length > 0) {
    throw new Error('Provide the task either as arguments or with --file, not both')
  }

  let task = taskPositionals.join(' ').trim()
  if (values.file !== undefined) {
    task = (await readFile(resolve(deps.cwd(), values.file), 'utf8')).trim()
  }
  if (!task) task = (await deps.readStdin()) ?? ''
  // Before the API-key check, so a placeholder is reported first and nothing
  // billable is set up for it.
  const allowAnyTask = values['allow-any-task']
  task = allowAnyTask ? requireNonEmptyTask(task) : validateTask(task)
  if (!deps.env.TYPESAFE_API_KEY?.trim()) {
    throw new Error(
      'TYPESAFE_API_KEY is not set. Create a key at https://console.typesafe.ai/keys and export it first.',
    )
  }

  const finalizer = parseFinalizer(values.finalizer)
  const jevModel = values['jev-model']
  const planner = deps.createPlanner({
    ...(values['codex-model'] === undefined ? {} : { codexModel: values['codex-model'] }),
    ...(values['claude-model'] === undefined ? {} : { claudeModel: values['claude-model'] }),
  })
  const result = await planner.plan({
    task,
    cwd,
    timeoutMs: parseTimeout(values.timeout),
    maxReviewRounds: parseReviewRounds(values['review-rounds']),
    ...(jevModel ? { jevModel } : {}),
    ...(finalizer ? { finalizer } : {}),
    ...(allowAnyTask ? { allowAnyTask } : {}),
    onStage: (message) => {
      deps.stderr(`[jev-planner] ${message}\n`)
    },
  })

  if (values.verbose) {
    deps.stderr(`[jev-planner] Jev verdict:\n${JSON.stringify(result.verdict, null, 2)}\n`)
  }

  const rendered = values.json
    ? `${JSON.stringify(
        { plan: result.plan, verdict: result.verdict, finalizer: result.finalizer },
        null,
        2,
      )}\n`
    : `${result.plan.trim()}\n`

  if (values.output === undefined) {
    deps.stdout(rendered)
  } else {
    const outputPath = resolve(cwd, values.output)
    await writeFile(outputPath, rendered, 'utf8')
    deps.stderr(`[jev-planner] Wrote ${outputPath}\n`)
  }
  return 0
}

/**
 * Runs the CLI and resolves to its exit code. Never rejects: every failure is
 * reported on stderr as `jev-planner: <message>` with exit code 1.
 */
export async function main(argv: readonly string[], deps: CliDeps): Promise<number> {
  try {
    return await run(argv, deps)
  } catch (error) {
    deps.stderr(`jev-planner: ${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}
