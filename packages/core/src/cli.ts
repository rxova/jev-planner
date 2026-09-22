import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { findConfig, validateAgentName } from './config.js'
import type { ConfigValues } from './config.js'
import { envCheck } from './doctor.js'
import type { CheckResult } from './doctor.js'
import { agentLabel } from './provider.js'
import type { AgentSetup, Provider } from './provider.js'
import { DEFAULT_AGENTS, PROVIDERS } from './providers.js'
import { requireNonEmptyTask, STDIN_CONFLICT_MESSAGE, validateTask } from './task.js'
import type {
  PlanCost,
  PlanMode,
  PlanningAgent,
  PlanOptions,
  PlanResult,
  PlanRound,
  ReviewMode,
} from './types.js'

/**
 * The program a CLI built on this package is: its name, and the judge it
 * plans with. `jev-planner` is one; each is a `bin` that calls `main` with it.
 */
export interface PlannerProgram {
  /**
   * The command, `jev-planner`: it names the help, every message, the config
   * file `<name>.json` and the runs folder `.<name>/`.
   */
  name: string
  version: string
  /** The help's first line, after the name. */
  summary: string
  /** How the help, the cost line and `--verbose` refer to the judge: `Jev`. */
  judge: string
  /** What `--judge-model` defaults to, for the help: `SDK's jev-latest`. */
  judgeModelDefault: string
  /**
   * The variables the judge reads: required before a paid call, checked by
   * `doctor`, stripped from every agent subprocess, and never read from a config.
   */
  judgeEnv: readonly JudgeEnv[]
}

/** A variable the judge reads, such as `TYPESAFE_API_KEY`. */
export interface JudgeEnv {
  variable: string
  /** What `doctor` calls the check: `TypeSafe key`. */
  check: string
  /** The error when it is not set: where to get one, and that it goes in the environment. */
  missing: string
}

/** The file a program's CLI looks for in the repository. */
const configFile = (program: PlannerProgram): string => `${program.name}.json`

/** Where a program's runs keep their rounds by default, relative to the repository. */
const runsDir = (program: PlannerProgram): string => `.${program.name}`

/**
 * Every secret the program knows of, the judge's and every provider's: what
 * `createAgents` is given as `omitEnv`, so no agent subprocess inherits one.
 */
export const secretEnv = (program: PlannerProgram): string[] => [
  ...program.judgeEnv.map(({ variable }) => variable),
  ...PROVIDERS.flatMap(({ secretEnv }) => secretEnv),
]

function agentLine(provider: Provider): string {
  const access =
    provider.kind === 'cli'
      ? `agent CLI, reads the repository${provider.effort ? '; takes --effort' : ''}`
      : `chat API, gets a repository snapshot; needs ${provider.secretEnv.join(', ')}`
  return `  ${provider.id.padEnd(26)}${provider.label}: ${access}`
}

/** `--help`'s text for `program`. */
export function helpText(program: PlannerProgram): string {
  const { name, judge } = program
  const variables = program.judgeEnv.map(({ variable }) => variable)
  const requires =
    variables.length > 0
      ? ` ${judge} requires ${variables.join(', ')}, which the config never holds.`
      : ''
  return `${name} — ${program.summary}

Usage:
  ${name} [plan] [options] "<coding task>"
  ${name} doctor [--agents <agents>] [--cwd <directory>]

Options:
  -c, --config <path>         Read the run's settings from this JSON file
                              (default: ${configFile(program)} in the repository, if there is one)
      --no-config             Read no config file
  -C, --cwd <directory>       Repository to inspect (default: current directory)
  -f, --file <path>           Read the coding task from a UTF-8 file
  -o, --output <path>         Write the final plan to a file instead of stdout
  -a, --agents <provider[:name],…>
                              Two or more comma-separated agents (default: ${DEFAULT_AGENTS.join(',')});
                              a provider can appear twice under different names,
                              as codex:sol,codex:terra
  -m, --model <name>=<model>  Override one agent's model; repeatable
  -e, --effort <name>=<level> Override one agent's reasoning effort; repeatable
      --review-effort <name>=<level>
                              The effort for its cross-review and synthesis only; repeatable
      --judge-model <model>   Override ${judge}'s model (default: ${program.judgeModelDefault})
      --finalizer <name>      auto, none, or one of the agents (default: auto/${judge} decides);
                              none keeps a cross-reviewed plan ${judge} rates stronger, unmerged
      --mode <fast|balanced|ultra>
                              fast: answer with the first draft ${judge} accepts alone
                              balanced: ${judge} skips the rounds a run does not need
                              ultra: always cross-review, then merge (default: balanced)
      --review-rounds <0|1|2> Maximum cross-review rounds (default: 2)
      --review-mode <standard|debate>
                              debate: agents critique each other, authors answer,
                              ${judge} rules on the disagreements (experimental; default: standard)
      --claim-checks          In a debate, have two agents that read the repository
                              check the disputed claims about it; implies debate
      --straggler-grace <s>   In balanced and fast mode, how long a round waits for the agents
                              still working once half have answered; 0 waits for
                              every agent (default: 90)
      --timeout <seconds>     Timeout for each agent call (default: 600)
      --no-resume             Start each agent call afresh, not from its draft session
      --json                  Emit plan metadata as JSON
      --verbose               Stream each agent's work, then ${judge}'s verdict, to stderr
      --rounds-dir <path>     Write every round's plans to round1/, round2/, …, final/
                              (default: .${name}/<run>/ in the repository)
      --no-rounds             Do not write the rounds anywhere
      --allow-any-task        Plan the task even if it looks like a placeholder
  -h, --help                  Show help
  -v, --version               Show version

Agents:
${PROVIDERS.map(agentLine).join('\n')}

The task can also be piped on stdin. A flag given here beats the config; --json,
--verbose, --claim-checks and --allow-any-task each have a --no- form, and --resume
and --rounds turn back on what the config turned off. Agent CLIs use their existing
logins.${requires}`
}

/** The planner surface the CLI drives; `Planner` in production, a fake in tests. */
export interface PlanRunner {
  plan(options: PlanOptions): Promise<PlanResult>
}

/** One of the run's agents: a provider under a name, its id unless `--agents` named it. */
export interface AgentSpec {
  name: string
  label: string
  provider: Provider
}

/**
 * The run's agents and model overrides, from the flags and the config,
 * handed to the planner factory.
 */
export interface PlannerSetup {
  agents: readonly AgentSpec[]
  /** `--model` overrides, or a config agent's `model`, by agent name. */
  models: Readonly<Record<string, string>>
  /** `--effort` overrides, or a config agent's `effort`, by agent name. */
  efforts: Readonly<Record<string, string>>
}

/** The planner's agents for `setup`: each spec's provider, built under the spec's name and label. */
export function createAgents(
  setup: PlannerSetup,
  env: AgentSetup['env'],
  omitEnv: readonly string[],
): PlanningAgent[] {
  return setup.agents.map(({ name, label, provider }) =>
    provider.create({
      name,
      label,
      ...(setup.models[name] === undefined ? {} : { model: setup.models[name] }),
      ...(setup.efforts[name] === undefined ? {} : { effort: setup.efforts[name] }),
      omitEnv,
      env,
    }),
  )
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
  /** The providers' checks; `main` adds one per `PlannerProgram.judgeEnv` variable. */
  doctor: (cwd: string, providers: readonly Provider[]) => Promise<CheckResult[]>
  /** The clock that names a run's folder under `.<name>/`. */
  now: () => Date
  program: PlannerProgram
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

/** `<provider>[:<name>]`, as `--agents` and the config's `agents` list it. */
function agentSpec(entry: string): AgentSpec {
  const [id = '', name, ...rest] = entry.split(':').map((part) => part.trim().toLowerCase())
  if (rest.length > 0) {
    throw new Error(`Invalid agent in --agents: ${entry}. Expected <provider>[:<name>].`)
  }
  const found = provider(id, '--agents')
  const resolved = name === undefined ? found.id : validateAgentName(name, found.id)
  return { name: resolved, label: agentLabel(found, resolved), provider: found }
}

function parseAgents(value: string | undefined): AgentSpec[] {
  const agents = (value ?? DEFAULT_AGENTS.join(','))
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map(agentSpec)
  const names = agents.map(({ name }) => name)
  const duplicate = names.find((name, index) => names.indexOf(name) !== index)
  if (duplicate !== undefined) {
    const hint = PROVIDERS.some(({ id }) => id === duplicate)
      ? `; name each instance: ${duplicate}:a,${duplicate}:b`
      : ''
    throw new Error(`--agents lists ${duplicate} more than once${hint}`)
  }
  if (agents.length < 2) throw new Error('--agents needs at least two agents')
  return agents
}

/** The run's agent `name` sets, or an error that says what `name` is instead. */
function agentNamed(name: string, flag: string, agents: readonly AgentSpec[]): AgentSpec {
  const found = agents.find((agent) => agent.name === name)
  if (found) return found
  const instances = agents.filter((agent) => agent.provider.id === name)
  const first = instances[0]
  if (first) {
    throw new Error(
      `${flag} ${name}: the run's ${first.provider.label} agents are ${instances.map((agent) => agent.name).join(', ')}; name one`,
    )
  }
  if (PROVIDERS.some(({ id }) => id === name)) {
    throw new Error(`${flag} sets ${name}, which is not one of the --agents`)
  }
  throw new Error(
    `Unknown agent in ${flag}: ${name}. Expected one of ${agents.map((agent) => agent.name).join(', ')}.`,
  )
}

/** Repeated `<name>=<value>` flags, by agent name; each must be one of the run's agents. */
function parseOverrides(
  flag: string,
  values: readonly string[],
  agents: readonly AgentSpec[],
  accepts: (provider: Provider) => boolean = () => true,
): Record<string, string> {
  const overrides: Record<string, string> = {}
  const placeholder = flag.slice(2)
  for (const value of values) {
    const separator = value.indexOf('=')
    const name = value.slice(0, separator).trim().toLowerCase()
    const setting = value.slice(separator + 1).trim()
    if (separator < 0 || !name || !setting) {
      throw new Error(`Invalid ${flag} value: ${value}. Expected <agent>=<${placeholder}>.`)
    }
    const agent = agentNamed(name, flag, agents)
    if (!accepts(agent.provider)) throw new Error(`${agent.provider.label} does not take ${flag}`)
    overrides[name] = setting
  }
  return overrides
}

/** `auto` gives `undefined`, `none` gives `'none'`, an agent gives its name. */
function parseFinalizer(
  value: string | undefined,
  agents: readonly AgentSpec[],
): string | undefined {
  if (value === undefined || value === 'auto') return undefined
  const name = value.toLowerCase()
  if (name === 'none' || agents.some((agent) => agent.name === name)) return name
  throw new Error(
    `Invalid --finalizer value: ${value}. Expected auto, none or one of ${agents.map((a) => a.name).join(', ')}.`,
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
 * A new folder for this run under `home`, `<cwd>/.<name>/` unless the
 * config names a `runsDir`, named by its UTC start time with no `:` so it is a valid name on Windows too. A second run in the
 * same second gets `-2`, and so on: `mkdir` without `recursive` fails on an
 * existing folder, so two runs can never claim the same one.
 *
 * The first run also writes `.gitignore` with `*` in `home`, so the output
 * never shows up as untracked in the repository being planned. One that is
 * already there is left alone.
 */
async function newRunDir(home: string, now: Date, name: string): Promise<string> {
  await mkdir(home, { recursive: true })
  await writeFile(join(home, '.gitignore'), `# Written by ${name}: run output, not source.\n*\n`, {
    flag: 'wx',
  }).catch((error: unknown) => {
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
 * One folder per round: `round<N>/<agent>.md` for each agent's plan, with the judge's
 * `verdict.json` beside a judged round's plans, `timings.json` in every
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
  if (round.verdict) files.push(['verdict.json', json(round.verdict)])
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

/** One line per round for `--verbose`: the round, then each agent call and the judge's. */
function roundTimingLine(
  round: PlanRound,
  labels: ReadonlyMap<string, string>,
  judge: string,
): string {
  const calls = [
    ...Object.entries(round.timings.agents).map(
      ([agent, ms]) => `${labels.get(agent) ?? agent} ${formatDuration(ms)}`,
    ),
    ...(round.timings.judgeMs === undefined
      ? []
      : [`${judge} ${formatDuration(round.timings.judgeMs)}`]),
  ]
  const line = `${STAGE_NAMES[round.stage]}: ${formatDuration(round.timings.totalMs)}`
  return calls.length > 0 ? `${line} (${calls.join(', ')})` : line
}

/**
 * What the run spent, on one line, so the cost of a mode is visible without
 * `--json`. `judge` names the judge's calls: `Jev`.
 */
export function costLine(cost: PlanCost, judge: string): string {
  const plural = (count: number, thing: string) =>
    `${String(count)} ${thing}${count === 1 ? '' : 's'}`
  const parts = [
    `${cost.mode} mode`,
    ...(cost.reviewMode === 'debate' ? ['debate review'] : []),
    plural(cost.agentCalls, 'agent call'),
    plural(cost.judgeCalls, `${judge} call`),
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

/**
 * A boolean flag and its `--no-` form: `undefined` when neither was given, so
 * the config decides. Written out rather than with `allowNegative`, which also
 * takes `--no-cwd` and the like as `false`.
 */
function toggle(on: boolean | undefined, off: boolean | undefined, name: string) {
  if (on && off) throw new Error(`Pass --${name} or --no-${name}, not both`)
  return on ? true : off ? false : undefined
}

/**
 * The config's per-agent `<name>=<value>` entries for the run's agents only,
 * then the flags', which win. An entry is kept only where the run's agent of
 * that name has the provider the config gave it, so a Codex model set for
 * `sol` never reaches `--agents claude:sol`.
 */
function withConfig(
  configured: readonly string[],
  given: readonly string[],
  agents: readonly AgentSpec[],
  configAgents: string | undefined,
): string[] {
  const providerOf = new Map(
    (configAgents ?? '').split(',').map((entry) => {
      const [id = '', name = id] = entry.split(':')
      return [name, id]
    }),
  )
  return [
    ...configured.filter((entry) => {
      const name = entry.slice(0, entry.indexOf('='))
      return agents.some(
        (agent) => agent.name === name && agent.provider.id === providerOf.get(name),
      )
    }),
    ...given,
  ]
}

/**
 * A warning for agents of one provider with the same model and draft effort,
 * whose drafts may barely differ; `undefined` when every agent differs.
 */
function identicalWarning(
  agents: readonly AgentSpec[],
  models: Readonly<Record<string, string>>,
  efforts: Readonly<Record<string, string>>,
): string | undefined {
  const groups = new Map<string, AgentSpec[]>()
  for (const agent of agents) {
    const key = JSON.stringify([agent.provider.id, models[agent.name], efforts[agent.name]])
    groups.set(key, [...(groups.get(key) ?? []), agent])
  }
  const same = [...groups.values()].find((group) => group.length > 1)
  if (!same) return undefined
  const names = same.map(({ name }) => name)
  const list = `${names.slice(0, -1).join(', ')} and ${String(names.at(-1))}`
  const [first] = same
  return `${list} are ${same.length > 2 ? 'all' : 'both'} ${String(first?.provider.label)} with the same model and effort; their drafts may barely differ. Vary --model or --effort.`
}

const NO_CONFIG: ConfigValues = { model: [], effort: [], 'review-effort': [] }

function parse(argv: readonly string[]) {
  return parseArgs({
    args: [...argv],
    allowPositionals: true,
    strict: true,
    options: {
      config: { type: 'string', short: 'c' },
      'no-config': { type: 'boolean' },
      cwd: { type: 'string', short: 'C' },
      file: { type: 'string', short: 'f' },
      output: { type: 'string', short: 'o' },
      agents: { type: 'string', short: 'a' },
      model: { type: 'string', short: 'm', multiple: true, default: [] },
      effort: { type: 'string', short: 'e', multiple: true, default: [] },
      'review-effort': { type: 'string', multiple: true, default: [] },
      'judge-model': { type: 'string' },
      finalizer: { type: 'string' },
      mode: { type: 'string' },
      'review-rounds': { type: 'string' },
      'review-mode': { type: 'string' },
      'claim-checks': { type: 'boolean' },
      'no-claim-checks': { type: 'boolean' },
      'straggler-grace': { type: 'string' },
      timeout: { type: 'string' },
      resume: { type: 'boolean' },
      'no-resume': { type: 'boolean' },
      json: { type: 'boolean' },
      'no-json': { type: 'boolean' },
      verbose: { type: 'boolean' },
      'no-verbose': { type: 'boolean' },
      'rounds-dir': { type: 'string' },
      rounds: { type: 'boolean' },
      'no-rounds': { type: 'boolean' },
      'allow-any-task': { type: 'boolean' },
      'no-allow-any-task': { type: 'boolean' },
      help: { type: 'boolean', short: 'h', default: false },
      version: { type: 'boolean', short: 'v', default: false },
    },
  })
}

async function run(argv: readonly string[], deps: CliDeps): Promise<number> {
  const { values, positionals } = parse(argv)

  const { program } = deps
  const say = (message: string) => {
    deps.stderr(`[${program.name}] ${message}\n`)
  }
  if (values.help) {
    deps.stdout(`${helpText(program)}\n`)
    return 0
  }
  if (values.version) {
    deps.stdout(`${program.version}\n`)
    return 0
  }

  const invoked = deps.cwd()
  if (values.config !== undefined && values['no-config']) {
    throw new Error('Pass --config or --no-config, not both')
  }
  const config = values['no-config']
    ? undefined
    : await findConfig(
        resolve(invoked, values.cwd ?? '.'),
        values.config === undefined ? undefined : resolve(invoked, values.config),
        {
          file: configFile(program),
          judgeEnv: program.judgeEnv.map(({ variable }) => variable),
        },
      )
  if (config) say(`Using config ${config.path}`)
  const configured = config?.values ?? NO_CONFIG

  const cwd = values.cwd === undefined ? (configured.cwd ?? invoked) : resolve(invoked, values.cwd)
  await assertDirectory(cwd)

  const agents = parseAgents(values.agents ?? configured.agents)
  if (positionals[0] === 'doctor') {
    if (positionals.length > 1) throw new Error('doctor does not accept a task')
    const providers = [...new Set(agents.map(({ provider }) => provider))]
    const checks = [
      ...(await deps.doctor(cwd, providers)),
      ...program.judgeEnv.map(({ check, variable }) => envCheck(check, variable, deps.env)),
    ]
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
    task = (await readFile(resolve(invoked, values.file), 'utf8')).trim()
  }
  if (!task) {
    // stdin is read even when the config has a task, so a pipe is never
    // silently ignored in favour of a billable configured one.
    const piped = (await deps.readStdin())?.trim() ?? ''
    if (piped && (configured.task ?? configured.taskFile) !== undefined) {
      throw new Error(STDIN_CONFLICT_MESSAGE)
    }
    if (configured.task !== undefined) task = configured.task
    else if (configured.taskFile !== undefined) {
      task = (await readFile(configured.taskFile, 'utf8')).trim()
    } else task = piped
  }
  // Before the API-key check, so a placeholder is reported first and nothing
  // billable is set up for it.
  const allowAnyTask =
    toggle(values['allow-any-task'], values['no-allow-any-task'], 'allow-any-task') ??
    configured['allow-any-task'] ??
    false
  task = allowAnyTask ? requireNonEmptyTask(task) : validateTask(task)
  const unset = program.judgeEnv.find(({ variable }) => !deps.env[variable]?.trim())
  if (unset) throw new Error(unset.missing)

  const models = parseOverrides(
    '--model',
    withConfig(configured.model, values.model, agents, configured.agents),
    agents,
  )
  const efforts = parseOverrides(
    '--effort',
    withConfig(configured.effort, values.effort, agents, configured.agents),
    agents,
    (provider) => provider.effort,
  )
  const reviewEfforts = parseOverrides(
    '--review-effort',
    withConfig(configured['review-effort'], values['review-effort'], agents, configured.agents),
    agents,
    (provider) => provider.effort,
  )
  const finalizer = parseFinalizer(values.finalizer ?? configured.finalizer, agents)
  const judgeModel = values['judge-model'] ?? configured['judge-model']
  const mode = parseMode(values.mode ?? configured.mode)
  const stragglerGraceMs = parseStragglerGrace(
    values['straggler-grace'] ?? configured['straggler-grace'],
    mode,
  )
  const maxReviewRounds = parseReviewRounds(values['review-rounds'] ?? configured['review-rounds'])
  const claimChecks =
    toggle(values['claim-checks'], values['no-claim-checks'], 'claim-checks') ??
    configured['claim-checks'] ??
    false
  const reviewMode = parseReviewMode(
    values['review-mode'] ?? configured['review-mode'],
    claimChecks,
    maxReviewRounds,
    mode,
  )
  const resume = toggle(values.resume, values['no-resume'], 'resume') ?? configured.resume ?? true
  const asJson = toggle(values.json, values['no-json'], 'json') ?? configured.json ?? false
  const verbose =
    toggle(values.verbose, values['no-verbose'], 'verbose') ?? configured.verbose ?? false
  const rounds = toggle(values.rounds, values['no-rounds'], 'rounds')
  if (rounds === false && values['rounds-dir'] !== undefined) {
    throw new Error('Pass --rounds-dir or --no-rounds, not both')
  }
  let roundsDir: string | undefined
  if (values['rounds-dir'] !== undefined) {
    roundsDir = resolve(cwd, values['rounds-dir'])
    await prepareRoundsDir(roundsDir)
  } else if (rounds ?? configured.rounds ?? true) {
    roundsDir = await newRunDir(
      configured.runsDir ?? join(cwd, runsDir(program)),
      deps.now(),
      program.name,
    )
  }
  if (roundsDir !== undefined) say(`Writing rounds to ${roundsDir}`)
  // Before the planner and any paid call, so it is read while there is time to stop.
  const warning = identicalWarning(agents, models, efforts)
  if (warning !== undefined) say(warning)
  const planner = deps.createPlanner({ agents, models, efforts })
  const labels = new Map(agents.map(({ name, label }) => [name, label]))
  const result = await planner.plan({
    task,
    cwd,
    timeoutMs: parseTimeout(values.timeout ?? configured.timeout),
    mode,
    maxReviewRounds,
    ...(reviewMode === 'debate' ? { reviewMode } : {}),
    ...(claimChecks ? { claimChecks } : {}),
    ...(stragglerGraceMs === undefined ? {} : { stragglerGraceMs }),
    ...(judgeModel ? { judgeModel } : {}),
    ...(finalizer === 'none' ? { selectStronger: true } : finalizer ? { finalizer } : {}),
    ...(allowAnyTask ? { allowAnyTask } : {}),
    ...(Object.keys(reviewEfforts).length > 0 ? { reviewEfforts } : {}),
    ...(resume ? {} : { resume: false }),
    onStage: say,
    ...(verbose
      ? {
          onAgentProgress: (agent: string, progress: string) => {
            for (const line of progress.split('\n')) deps.stderr(`[${agent}] ${line}\n`)
          },
        }
      : {}),
    ...(roundsDir === undefined && !verbose
      ? {}
      : {
          onRound: async (round: PlanRound) => {
            if (verbose) say(roundTimingLine(round, labels, program.judge))
            if (roundsDir !== undefined) await writeRound(roundsDir, round)
          },
        }),
  })

  if (verbose) {
    say(`Total: ${formatDuration(result.timings.totalMs)}`)
    say(`${program.judge} verdict:\n${JSON.stringify(result.verdict, null, 2)}`)
  }
  say(costLine(result.cost, program.judge))

  const rendered = asJson
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

  const output = values.output ?? configured.output
  if (output === undefined) {
    deps.stdout(rendered)
  } else {
    const outputPath = resolve(cwd, output)
    await writeFile(outputPath, rendered, 'utf8')
    say(`Wrote ${outputPath}`)
  }
  return 0
}

/**
 * Runs the CLI and resolves to its exit code. Never rejects: every failure is
 * reported on stderr as `<name>: <message>` with exit code 1.
 */
export async function main(argv: readonly string[], deps: CliDeps): Promise<number> {
  try {
    return await run(argv, deps)
  } catch (error) {
    deps.stderr(`${deps.program.name}: ${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}
