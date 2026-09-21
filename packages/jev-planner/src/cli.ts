import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import packageJson from '../package.json' with { type: 'json' }
import type { CheckResult } from './doctor.js'
import type { Provider } from './provider.js'
import { DEFAULT_AGENTS, PROVIDERS } from './providers.js'
import { requireNonEmptyTask, validateTask } from './task.js'
import type { PlanOptions, PlanResult, PlanRound } from './types.js'

export const VERSION: string = packageJson.version

function agentLine(provider: Provider): string {
  const access =
    provider.kind === 'cli'
      ? `agent CLI, reads the repository${provider.effort ? '; takes --effort' : ''}`
      : `chat API, gets a repository snapshot; needs ${provider.secretEnv.join(', ')}`
  return `  ${provider.id.padEnd(26)}${provider.label}: ${access}`
}

export const HELP = `jev-planner — collaborative coding plans from several AIs, judged by Jev

Usage:
  jev-planner [plan] [options] "<coding task>"
  jev-planner doctor [--agents <ids>] [--cwd <directory>]

Options:
  -C, --cwd <directory>       Repository to inspect (default: current directory)
  -f, --file <path>           Read the coding task from a UTF-8 file
  -o, --output <path>         Write the final plan to a file instead of stdout
  -a, --agents <ids>          Two or more comma-separated agents (default: ${DEFAULT_AGENTS.join(',')})
  -m, --model <id>=<model>    Override one agent's model; repeatable
  -e, --effort <id>=<level>   Override one agent's reasoning effort; repeatable
      --jev-model <model>     Override Jev (default: SDK's jev-latest)
      --finalizer <id>        auto, or one of the agents (default: auto/Jev decides)
      --review-rounds <1|2>   Maximum cross-review rounds (default: 2)
      --timeout <seconds>     Timeout for each agent call (default: 600)
      --json                  Emit plan metadata as JSON
      --verbose               Print Jev's typed verdict to stderr
      --rounds-dir <path>     Write every round's plans to round1/, round2/, …, final/
      --allow-any-task        Plan the task even if it looks like a placeholder
  -h, --help                  Show help
  -v, --version               Show version

Agents:
${PROVIDERS.map(agentLine).join('\n')}

The task can also be piped on stdin. Agent CLIs use their existing logins.
Jev requires TYPESAFE_API_KEY.`

/** The planner surface the CLI drives; `Planner` in production, a fake in tests. */
export interface PlanRunner {
  plan(options: PlanOptions): Promise<PlanResult>
}

/** The run's agents and model overrides from the command line, handed to the planner factory. */
export interface PlannerSetup {
  agents: readonly Provider[]
  /** `--model` overrides, by provider id. */
  models: Readonly<Record<string, string>>
  /** `--effort` overrides, by provider id. */
  efforts: Readonly<Record<string, string>>
}

/** Everything `main` touches outside its arguments, so tests can replace it. */
export interface CliDeps {
  stdout: (text: string) => void
  stderr: (text: string) => void
  env: Readonly<Record<string, string | undefined>>
  cwd: () => string
  /** The piped task, or `undefined` when stdin is a terminal. */
  readStdin: () => Promise<string | undefined>
  createPlanner: (setup: PlannerSetup) => PlanRunner
  doctor: (cwd: string, providers: readonly Provider[]) => Promise<CheckResult[]>
}

async function assertDirectory(path: string): Promise<void> {
  const info = await stat(path).catch(() => undefined)
  if (!info?.isDirectory()) throw new Error(`Not a directory: ${path}`)
}

const PROVIDER_IDS = PROVIDERS.map(({ id }) => id).join(', ')

function provider(id: string, flag: string): Provider {
  const found = PROVIDERS.find((candidate) => candidate.id === id)
  if (!found) throw new Error(`Unknown agent in ${flag}: ${id}. Expected one of ${PROVIDER_IDS}.`)
  return found
}

function parseAgents(value: string | undefined): Provider[] {
  const ids = (value ?? DEFAULT_AGENTS.join(','))
    .split(',')
    .map((id) => id.trim().toLowerCase())
    .filter(Boolean)
  const duplicate = ids.find((id, index) => ids.indexOf(id) !== index)
  if (duplicate !== undefined) throw new Error(`--agents lists ${duplicate} more than once`)
  const agents = ids.map((id) => provider(id, '--agents'))
  if (agents.length < 2) throw new Error('--agents needs at least two agents')
  return agents
}

/** Repeated `<id>=<value>` flags, by agent id; each id must be one of the run's agents. */
function parseOverrides(
  flag: string,
  values: readonly string[],
  agents: readonly Provider[],
  accepts: (agent: Provider) => boolean = () => true,
): Record<string, string> {
  const overrides: Record<string, string> = {}
  const placeholder = flag.slice(2)
  for (const value of values) {
    const separator = value.indexOf('=')
    const id = value.slice(0, separator).trim().toLowerCase()
    const setting = value.slice(separator + 1).trim()
    if (separator < 0 || !id || !setting) {
      throw new Error(`Invalid ${flag} value: ${value}. Expected <agent>=<${placeholder}>.`)
    }
    const agent = provider(id, flag)
    if (!agents.includes(agent))
      throw new Error(`${flag} sets ${id}, which is not one of the --agents`)
    if (!accepts(agent)) throw new Error(`${agent.label} does not take ${flag}`)
    overrides[id] = setting
  }
  return overrides
}

function parseFinalizer(
  value: string | undefined,
  agents: readonly Provider[],
): string | undefined {
  if (value === undefined || value === 'auto') return undefined
  const id = value.toLowerCase()
  if (agents.some((agent) => agent.id === id)) return id
  throw new Error(
    `Invalid --finalizer value: ${value}. Expected auto or one of ${agents.map((a) => a.id).join(', ')}.`,
  )
}

/** Creates `dir`, which must be new or empty so rounds from different runs never mix. */
async function prepareRoundsDir(dir: string): Promise<void> {
  const entries = await readdir(dir).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  })
  if (entries.length > 0) throw new Error(`--rounds-dir must be new or empty: ${dir}`)
  await mkdir(dir, { recursive: true })
}

/**
 * One folder per round: `round<N>/<agent>.md` for each agent's plan, with Jev's
 * `jev-verdict.json` beside a judged round's plans, and `final/plan.md` last.
 */
async function writeRound(dir: string, round: PlanRound): Promise<void> {
  const folder = join(dir, round.stage === 'final' ? 'final' : `round${String(round.round)}`)
  await mkdir(folder, { recursive: true })
  const files: [string, string][] =
    round.stage === 'final'
      ? Object.entries(round.plans).map(([agent, plan]) => [
          'plan.md',
          `<!-- merged by ${agent} -->\n${plan.trim()}\n`,
        ])
      : Object.entries(round.plans).map(([agent, plan]) => [`${agent}.md`, `${plan.trim()}\n`])
  if (round.verdict) files.push(['jev-verdict.json', `${JSON.stringify(round.verdict, null, 2)}\n`])
  await Promise.all(files.map(([name, text]) => writeFile(join(folder, name), text, 'utf8')))
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
      agents: { type: 'string', short: 'a' },
      model: { type: 'string', short: 'm', multiple: true, default: [] },
      effort: { type: 'string', short: 'e', multiple: true, default: [] },
      'jev-model': { type: 'string' },
      finalizer: { type: 'string' },
      'review-rounds': { type: 'string' },
      timeout: { type: 'string' },
      json: { type: 'boolean', default: false },
      verbose: { type: 'boolean', default: false },
      'rounds-dir': { type: 'string' },
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

  const agents = parseAgents(values.agents)
  if (positionals[0] === 'doctor') {
    if (positionals.length > 1) throw new Error('doctor does not accept a task')
    const checks = await deps.doctor(cwd, agents)
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

  const models = parseOverrides('--model', values.model, agents)
  const efforts = parseOverrides('--effort', values.effort, agents, (agent) => agent.effort)
  const finalizer = parseFinalizer(values.finalizer, agents)
  const jevModel = values['jev-model']
  const roundsDir =
    values['rounds-dir'] === undefined ? undefined : resolve(cwd, values['rounds-dir'])
  if (roundsDir !== undefined) await prepareRoundsDir(roundsDir)
  const planner = deps.createPlanner({ agents, models, efforts })
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
    ...(roundsDir === undefined
      ? {}
      : { onRound: (round: PlanRound) => writeRound(roundsDir, round) }),
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
