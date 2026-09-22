import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import packageJson from '../package.json' with { type: 'json' }
import type { CheckResult } from './doctor.js'
import type { Provider } from './provider.js'
import { DEFAULT_AGENTS, PROVIDERS } from './providers.js'
import { requireNonEmptyTask, validateTask } from './task.js'
import type { PlanCost, PlanMode, PlanOptions, PlanResult, PlanRound, ReviewMode } from './types.js'

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
      --review-effort <id>=<level>
                              The effort for its cross-review and synthesis only; repeatable
      --jev-model <model>     Override Jev (default: SDK's jev-latest)
      --finalizer <id>        auto, none, or one of the agents (default: auto/Jev decides);
                              none keeps a cross-reviewed plan Jev rates stronger, unmerged
      --mode <fast|balanced|ultra>
                              fast: answer with the first draft Jev accepts alone
                              balanced: Jev skips the rounds a run does not need
                              ultra: always cross-review, always merge (default: balanced)
      --review-rounds <0|1|2> Maximum cross-review rounds (default: 2)
      --review-mode <standard|debate>
                              debate: agents critique each other, authors answer,
                              Jev rules on the disagreements (experimental; default: standard)
      --claim-checks          In a debate, have two agents that read the repository
                              check the disputed claims about it; implies debate
      --straggler-grace <s>   In balanced and fast mode, how long a round waits for the agents
                              still working once half have answered; 0 waits for
                              every agent (default: 90)
      --timeout <seconds>     Timeout for each agent call (default: 600)
      --no-resume             Start each agent call afresh, not from its draft session
      --json                  Emit plan metadata as JSON
      --verbose               Stream each agent's work, then Jev's verdict, to stderr
      --rounds-dir <path>     Write every round's plans to round1/, round2/, …, final/
                              (default: .jev-planner/<run>/ in the repository)
      --no-rounds             Do not write the rounds anywhere
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
  /** The clock that names a run's folder under `.jev-planner/`. */
  now: () => Date
}

/** Where runs keep their rounds by default, relative to the repository. */
export const RUNS_DIR = '.jev-planner'

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

/** `auto` gives `undefined`, `none` gives `'none'`, an agent gives its id. */
function parseFinalizer(
  value: string | undefined,
  agents: readonly Provider[],
): string | undefined {
  if (value === undefined || value === 'auto') return undefined
  const id = value.toLowerCase()
  if (id === 'none' || agents.some((agent) => agent.id === id)) return id
  throw new Error(
    `Invalid --finalizer value: ${value}. Expected auto, none or one of ${agents.map((a) => a.id).join(', ')}.`,
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
 * A new folder for this run under `<cwd>/.jev-planner/`, named by its UTC start
 * time with no `:` so it is a valid name on Windows too. A second run in the
 * same second gets `-2`, and so on: `mkdir` without `recursive` fails on an
 * existing folder, so two runs can never claim the same one.
 *
 * The first run also writes `.jev-planner/.gitignore` with `*`, so the output
 * never shows up as untracked in the repository being planned. One that is
 * already there is left alone.
 */
async function newRunDir(cwd: string, now: Date): Promise<string> {
  const home = join(cwd, RUNS_DIR)
  await mkdir(home, { recursive: true })
  await writeFile(
    join(home, '.gitignore'),
    '# Written by jev-planner: run output, not source.\n*\n',
    {
      flag: 'wx',
    },
  ).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  })
  const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
  for (let attempt = 1; ; attempt++) {
    const dir = join(home, attempt === 1 ? stamp : `${stamp}-${String(attempt)}`)
    try {
      await mkdir(dir)
      return dir
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
}

/** What a debate round's raw answers are saved as, beside its plans. */
const ARTIFACT_SUFFIX: Partial<Record<PlanRound['stage'], string>> = {
  critique: 'critique',
  reply: 'reply',
  review: 'reply',
  check: 'check',
}

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`

/**
 * One folder per round: `round<N>/<agent>.md` for each agent's plan, with Jev's
 * `jev-verdict.json` beside a judged round's plans, `timings.json` in every
 * round, and `final/plan.md` last. A debate round adds each agent's raw answer
 * as `<agent>.critique.md`, `.reply.md` or `.check.md`, and what was parsed
 * from them as `objections.json`, `replies.json` and `disputes.json`; its
 * critique and check rounds leave the plans unchanged, so write none.
 */
async function writeRound(dir: string, round: PlanRound): Promise<void> {
  const folder = join(dir, round.stage === 'final' ? 'final' : `round${String(round.round)}`)
  await mkdir(folder, { recursive: true })
  const files: [string, string][] =
    round.stage === 'final'
      ? Object.entries(round.plans).map(([agent, plan]) => [
          'plan.md',
          `<!-- ${round.selected ? 'selected from' : 'merged by'} ${agent} -->\n${plan.trim()}\n`,
        ])
      : round.stage === 'critique' || round.stage === 'check'
        ? []
        : Object.entries(round.plans).map(([agent, plan]) => [`${agent}.md`, `${plan.trim()}\n`])
  const suffix = ARTIFACT_SUFFIX[round.stage]
  if (round.artifacts && suffix !== undefined) {
    for (const [agent, text] of Object.entries(round.artifacts)) {
      files.push([`${agent}.${suffix}.md`, `${text.trim()}\n`])
    }
  }
  const { debate } = round
  if (debate) {
    if (round.stage === 'critique') files.push(['objections.json', json(debate.objections)])
    if (debate.replies) {
      files.push([
        'replies.json',
        json({ replies: debate.replies, unanswered: debate.unanswered ?? [] }),
      ])
    }
    if (debate.disputes) {
      files.push([
        'disputes.json',
        json({
          disputes: debate.disputes,
          overflow: debate.overflow ?? [],
          ...(debate.claimChecks ? { claimChecks: debate.claimChecks } : {}),
        }),
      ])
    }
  }
  if (round.verdict) files.push(['jev-verdict.json', json(round.verdict)])
  files.push(['timings.json', `${JSON.stringify(round.timings, null, 2)}\n`])
  await Promise.all(files.map(([name, text]) => writeFile(join(folder, name), text, 'utf8')))
}

/** `4m12s`, `51s` or `0.8s`: minutes once a minute has passed, tenths below ten seconds. */
export function formatDuration(ms: number): string {
  const seconds = ms / 1_000
  if (seconds < 10) return `${seconds.toFixed(1)}s`
  const whole = Math.round(seconds)
  if (whole < 60) return `${String(whole)}s`
  return `${String(Math.floor(whole / 60))}m${String(whole % 60).padStart(2, '0')}s`
}

const STAGE_NAMES: Record<PlanRound['stage'], string> = {
  draft: 'Drafts',
  critique: 'Critiques',
  reply: 'Replies',
  check: 'Claim checks',
  review: 'Review',
  final: 'Final plan',
}

/** One line per round for `--verbose`: the round, then each agent call and Jev's. */
function roundTimingLine(round: PlanRound, labels: ReadonlyMap<string, string>): string {
  const calls = [
    ...Object.entries(round.timings.agents).map(
      ([agent, ms]) => `${labels.get(agent) ?? agent} ${formatDuration(ms)}`,
    ),
    ...(round.timings.jevMs === undefined ? [] : [`Jev ${formatDuration(round.timings.jevMs)}`]),
  ]
  const line = `${STAGE_NAMES[round.stage]}: ${formatDuration(round.timings.totalMs)}`
  return calls.length > 0 ? `${line} (${calls.join(', ')})` : line
}

/** What the run spent, on one line, so the cost of a mode is visible without `--json`. */
export function costLine(cost: PlanCost): string {
  const plural = (count: number, thing: string) =>
    `${String(count)} ${thing}${count === 1 ? '' : 's'}`
  const parts = [
    `${cost.mode} mode`,
    ...(cost.reviewMode === 'debate' ? ['debate review'] : []),
    plural(cost.agentCalls, 'agent call'),
    plural(cost.jevCalls, 'Jev call'),
    plural(cost.reviewRounds, 'cross-review round'),
    cost.synthesized ? 'merged' : cost.mode === 'fast' ? 'selected' : 'adopted whole',
  ]
  if (cost.dropped.length > 0) parts.push(`not waited for: ${cost.dropped.join(', ')}`)
  return parts.join(', ')
}

function parseTimeout(value: string | undefined): number {
  const seconds = Number(value ?? '600')
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error('--timeout must be a positive number of seconds')
  }
  return Math.round(seconds * 1_000)
}

function parseReviewRounds(value: string | undefined): 0 | 1 | 2 {
  if (value === undefined || value === '2') return 2
  if (value === '1') return 1
  if (value === '0') return 0
  throw new Error('--review-rounds must be 0, 1 or 2')
}

function parseMode(value: string | undefined): PlanMode {
  if (value === undefined || value === 'balanced') return 'balanced'
  if (value === 'ultra' || value === 'fast') return value
  throw new Error(`Invalid --mode value: ${value}. Expected fast, balanced or ultra.`)
}

function parseReviewMode(
  value: string | undefined,
  claimChecks: boolean,
  reviewRounds: number,
  planMode: PlanMode,
): ReviewMode {
  let mode: ReviewMode
  if (value === undefined) mode = claimChecks ? 'debate' : 'standard'
  else if (value === 'standard' || value === 'debate') mode = value
  else throw new Error(`Invalid --review-mode value: ${value}. Expected standard or debate.`)
  if (claimChecks && mode !== 'debate') {
    throw new Error('--claim-checks runs in the debate review; drop --review-mode standard')
  }
  if (mode === 'debate' && planMode === 'fast') {
    throw new Error(
      `${claimChecks ? '--claim-checks' : '--review-mode debate'} needs a review round, and --mode fast has none`,
    )
  }
  if (mode === 'debate' && reviewRounds === 0) {
    throw new Error('--review-mode debate is a review round; it needs --review-rounds 1 or 2')
  }
  return mode
}

function parseStragglerGrace(value: string | undefined, mode: PlanMode): number | undefined {
  if (value === undefined) return undefined
  if (mode === 'ultra')
    throw new Error('--straggler-grace is for --mode balanced or fast; ultra never drops an agent')
  const seconds = Number(value)
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new Error('--straggler-grace must be a number of seconds, 0 or more')
  }
  return Math.round(seconds * 1_000)
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
      'review-effort': { type: 'string', multiple: true, default: [] },
      'jev-model': { type: 'string' },
      finalizer: { type: 'string' },
      mode: { type: 'string' },
      'review-rounds': { type: 'string' },
      'review-mode': { type: 'string' },
      'claim-checks': { type: 'boolean', default: false },
      'straggler-grace': { type: 'string' },
      timeout: { type: 'string' },
      'no-resume': { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      verbose: { type: 'boolean', default: false },
      'rounds-dir': { type: 'string' },
      'no-rounds': { type: 'boolean', default: false },
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
  const reviewEfforts = parseOverrides(
    '--review-effort',
    values['review-effort'],
    agents,
    (agent) => agent.effort,
  )
  const finalizer = parseFinalizer(values.finalizer, agents)
  const jevModel = values['jev-model']
  const mode = parseMode(values.mode)
  const stragglerGraceMs = parseStragglerGrace(values['straggler-grace'], mode)
  const maxReviewRounds = parseReviewRounds(values['review-rounds'])
  const claimChecks = values['claim-checks']
  const reviewMode = parseReviewMode(values['review-mode'], claimChecks, maxReviewRounds, mode)
  if (values['no-rounds'] && values['rounds-dir'] !== undefined) {
    throw new Error('Pass --rounds-dir or --no-rounds, not both')
  }
  let roundsDir: string | undefined
  if (values['rounds-dir'] !== undefined) {
    roundsDir = resolve(cwd, values['rounds-dir'])
    await prepareRoundsDir(roundsDir)
  } else if (!values['no-rounds']) {
    roundsDir = await newRunDir(cwd, deps.now())
  }
  if (roundsDir !== undefined) deps.stderr(`[jev-planner] Writing rounds to ${roundsDir}\n`)
  const planner = deps.createPlanner({ agents, models, efforts })
  const labels = new Map(agents.map(({ id, label }) => [id, label]))
  const result = await planner.plan({
    task,
    cwd,
    timeoutMs: parseTimeout(values.timeout),
    mode,
    maxReviewRounds,
    ...(reviewMode === 'debate' ? { reviewMode } : {}),
    ...(claimChecks ? { claimChecks } : {}),
    ...(stragglerGraceMs === undefined ? {} : { stragglerGraceMs }),
    ...(jevModel ? { jevModel } : {}),
    ...(finalizer === 'none' ? { selectStronger: true } : finalizer ? { finalizer } : {}),
    ...(allowAnyTask ? { allowAnyTask } : {}),
    ...(Object.keys(reviewEfforts).length > 0 ? { reviewEfforts } : {}),
    ...(values['no-resume'] ? { resume: false } : {}),
    onStage: (message) => {
      deps.stderr(`[jev-planner] ${message}\n`)
    },
    ...(values.verbose
      ? {
          onAgentProgress: (agent: string, progress: string) => {
            for (const line of progress.split('\n')) deps.stderr(`[${agent}] ${line}\n`)
          },
        }
      : {}),
    ...(roundsDir === undefined && !values.verbose
      ? {}
      : {
          onRound: async (round: PlanRound) => {
            if (values.verbose) deps.stderr(`[jev-planner] ${roundTimingLine(round, labels)}\n`)
            if (roundsDir !== undefined) await writeRound(roundsDir, round)
          },
        }),
  })

  if (values.verbose) {
    deps.stderr(`[jev-planner] Total: ${formatDuration(result.timings.totalMs)}\n`)
    deps.stderr(`[jev-planner] Jev verdict:\n${JSON.stringify(result.verdict, null, 2)}\n`)
  }
  deps.stderr(`[jev-planner] ${costLine(result.cost)}\n`)

  const rendered = values.json
    ? `${JSON.stringify(
        {
          plan: result.plan,
          verdict: result.verdict,
          finalizer: result.finalizer,
          ...(result.selected ? { selected: true } : {}),
          ...(result.debate ? { debate: result.debate } : {}),
          timings: result.timings,
          cost: result.cost,
        },
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
