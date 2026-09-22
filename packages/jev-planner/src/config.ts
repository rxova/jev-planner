import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { PROVIDERS } from './providers.js'

/** The one file the CLI looks for in the repository. Not a dotfile, so it is not taken for run output. */
export const CONFIG_FILE = 'jev-planner.json'

/**
 * A config's settings, shaped like the flags they stand for, so `run()` merges
 * the two with `??`. Paths are absolute, resolved against the config's folder;
 * per-agent settings are `<id>=<value>` strings, as `--model` takes them.
 */
export interface ConfigValues {
  cwd?: string
  task?: string
  taskFile?: string
  output?: string
  /** A parent folder: each run gets its own timestamped folder in it. */
  runsDir?: string
  agents?: string
  model: string[]
  effort: string[]
  'review-effort': string[]
  mode?: string
  'review-mode'?: string
  'review-rounds'?: string
  finalizer?: string
  'jev-model'?: string
  'straggler-grace'?: string
  timeout?: string
  'claim-checks'?: boolean
  resume?: boolean
  rounds?: boolean
  json?: boolean
  verbose?: boolean
  'allow-any-task'?: boolean
}

/** A config that was read, and where from. */
export interface LoadedConfig {
  path: string
  values: ConfigValues
}

const IDS = PROVIDERS.map(({ id }) => id)
const PROVIDER_IDS = IDS.join(', ')

/** Where the keys a config must never hold belong instead. */
const SECRET_ENV = ['TYPESAFE_API_KEY', ...PROVIDERS.flatMap(({ secretEnv }) => secretEnv)]

const SECRET = /key|token|secret|password/i

function object(at: string, value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${at}: must be an object`)
  }
  return value as Record<string, unknown>
}

function string(at: string, value: unknown): string {
  if (typeof value !== 'string' || !value.trim())
    throw new Error(`${at}: must be a non-empty string`)
  return value.trim()
}

function boolean(at: string, value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Error(`${at}: must be true or false`)
  return value
}

function notOneOf(at: string, options: readonly (string | number)[]): Error {
  return new Error(
    `${at}: must be one of ${options.map((option) => JSON.stringify(option)).join(', ')}`,
  )
}

function choice<T extends string | number>(at: string, value: unknown, options: readonly T[]): T {
  if (!options.includes(value as T)) throw notOneOf(at, options)
  return value as T
}

/** A number of seconds, as the matching flag's text; zero only where `zero` allows it. */
function seconds(at: string, value: unknown, zero = false): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || (!zero && value === 0)) {
    throw new Error(
      `${at}: must be ${zero ? 'a number of seconds, 0 or more' : 'a positive number of seconds'}`,
    )
  }
  return String(value)
}

function unknownKey(at: string, expected: readonly string[]): Error {
  const key = at.slice(at.lastIndexOf('.') + 1)
  if (SECRET.test(key)) {
    return new Error(
      `${at}: a config never holds a secret; it is meant to be committed. ` +
        `Set ${SECRET_ENV.join(', ')} in the environment instead.`,
    )
  }
  return new Error(`${at}: unknown key. Expected one of ${expected.join(', ')}.`)
}

const AGENT_FIELDS = {
  model: 'model',
  effort: 'effort',
  reviewEffort: 'review-effort',
} as const

const NAME = /^[a-z][a-z0-9-]{0,23}$/

/** Taken by `--finalizer` (`auto`, `none`), by Jev's verdict (`tie`), or by Windows as a file name. */
const RESERVED = new Set([
  'auto',
  'none',
  'tie',
  'con',
  'prn',
  'aux',
  'nul',
  ...Array.from({ length: 9 }, (_, index) => `com${String(index + 1)}`),
  ...Array.from({ length: 9 }, (_, index) => `lpt${String(index + 1)}`),
])

/**
 * The name of an agent of `provider`, lowercased, or an error: a letter, then
 * letters, digits or `-`, 24 at most, so it fits an objection id
 * (`sol:terra:C1`) and a file name (`sol.md`) on every system. It cannot be a
 * word the run gives its own meaning, nor another provider's id.
 */
export function validateAgentName(name: string, provider: string): string {
  const lower = name.trim().toLowerCase()
  if (!NAME.test(lower)) {
    throw new Error(
      `${name}: an agent name is a letter, then letters, digits or -, at most 24 characters`,
    )
  }
  if (RESERVED.has(lower)) throw new Error(`${lower}: a reserved word, not an agent name`)
  if (lower !== provider && PROVIDERS.some(({ id }) => id === lower)) {
    throw new Error(`${lower}: the name of another provider, not an agent name`)
  }
  return lower
}

function agents(value: unknown): Partial<ConfigValues> {
  const entries = Object.entries(object('agents', value))
  if (entries.length < 2) throw new Error('agents: needs at least two agents')
  const values = { model: [] as string[], effort: [] as string[], 'review-effort': [] as string[] }
  const specs: string[] = []
  const names = new Set<string>()
  for (const [key, settings] of entries) {
    const fields = object(`agents.${key}`, settings)
    const own = PROVIDERS.find(({ id }) => id === key)
    const named = own === undefined
    if (!named && 'provider' in fields) {
      throw new Error(
        `agents.${key}.provider: a provider key names its own provider; use another key for an instance`,
      )
    }
    if (named && !('provider' in fields)) {
      throw new Error(
        `agents.${key}: unknown agent. Expected one of ${PROVIDER_IDS}. A named agent sets "provider".`,
      )
    }
    const provider = own ?? PROVIDERS.find(({ id }) => id === fields.provider)
    if (!provider) throw notOneOf(`agents.${key}.provider`, IDS)
    let name: string
    try {
      name = validateAgentName(key, provider.id)
    } catch (error) {
      throw new Error(`agents.${(error as Error).message}`, { cause: error })
    }
    if (names.has(name)) throw new Error(`agents.${key}: ${name} is listed more than once`)
    names.add(name)
    specs.push(named ? `${provider.id}:${name}` : name)
    for (const [field, setting] of Object.entries(fields)) {
      if (named && field === 'provider') continue
      const at = `agents.${key}.${field}`
      if (!Object.hasOwn(AGENT_FIELDS, field)) {
        throw unknownKey(at, [...(named ? ['provider'] : []), ...Object.keys(AGENT_FIELDS)])
      }
      const flag = AGENT_FIELDS[field as keyof typeof AGENT_FIELDS]
      if (flag !== 'model' && !provider.effort) {
        throw new Error(`${at}: ${provider.label} does not take effort`)
      }
      values[flag].push(`${name}=${string(at, setting)}`)
    }
  }
  return { agents: specs.join(','), ...values }
}

/** Every top-level key, what it becomes, and its check. The keys follow the flags' names. */
const SETTINGS: Record<string, (value: unknown, dir: string) => Partial<ConfigValues>> = {
  agents,
  mode: (value) => ({ mode: choice('mode', value, ['fast', 'balanced', 'ultra']) }),
  reviewMode: (value) => ({ 'review-mode': choice('reviewMode', value, ['standard', 'debate']) }),
  reviewRounds: (value) => ({ 'review-rounds': String(choice('reviewRounds', value, [0, 1, 2])) }),
  claimChecks: (value) => ({ 'claim-checks': boolean('claimChecks', value) }),
  finalizer: (value) => ({ finalizer: string('finalizer', value) }),
  jevModel: (value) => ({ 'jev-model': string('jevModel', value) }),
  stragglerGrace: (value) => ({ 'straggler-grace': seconds('stragglerGrace', value, true) }),
  timeout: (value) => ({ timeout: seconds('timeout', value) }),
  resume: (value) => ({ resume: boolean('resume', value) }),
  rounds: (value) => ({ rounds: boolean('rounds', value) }),
  json: (value) => ({ json: boolean('json', value) }),
  verbose: (value) => ({ verbose: boolean('verbose', value) }),
  allowAnyTask: (value) => ({ 'allow-any-task': boolean('allowAnyTask', value) }),
  runsDir: (value, dir) => ({ runsDir: resolve(dir, string('runsDir', value)) }),
  output: (value, dir) => ({ output: resolve(dir, string('output', value)) }),
  cwd: (value, dir) => ({ cwd: resolve(dir, string('cwd', value)) }),
  task: (value) => ({ task: string('task', value) }),
  taskFile: (value, dir) => ({ taskFile: resolve(dir, string('taskFile', value)) }),
}

/** Every key a config may hold, `$schema` included; `config.schema.json` must list the same. */
export const CONFIG_KEYS: readonly string[] = ['$schema', ...Object.keys(SETTINGS)]

/**
 * Checks a config's text and turns it into flag-shaped values. Every error
 * names the file and the key. Rules that span a config and the flags, such as
 * a finalizer that is not one of the run's agents, are left to the CLI's
 * parsers, which run on the merged values.
 *
 * `explicit` is whether the file was named with `--config`: only such a file
 * may set `cwd`, so a file found inside a repository cannot send the agents to
 * another one.
 */
export function parseConfig(text: string, path: string, explicit: boolean): ConfigValues {
  let raw: unknown
  try {
    raw = JSON.parse(text.replace(/^\uFEFF/, ''))
  } catch (error) {
    throw new Error(`${path}: not valid JSON: ${(error as Error).message}`, { cause: error })
  }
  const values: ConfigValues = { model: [], effort: [], 'review-effort': [] }
  try {
    const top = object('the top level', raw)
    const dir = dirname(path)
    for (const [key, value] of Object.entries(top)) {
      if (key === '$schema') continue
      if (!Object.hasOwn(SETTINGS, key)) throw unknownKey(key, CONFIG_KEYS)
      Object.assign(values, SETTINGS[key]?.(value, dir))
    }
    if ('cwd' in top && !explicit) {
      throw new Error(
        'cwd: allowed only in a file passed with --config, so a config inside a repository cannot point the agents at another one',
      )
    }
    if ('task' in top && 'taskFile' in top) throw new Error('task and taskFile: set one, not both')
    if (values.runsDir !== undefined && values.rounds === false) {
      throw new Error('runsDir and rounds: false: set one, not both')
    }
  } catch (error) {
    throw new Error(`${path}: ${(error as Error).message}`, { cause: error })
  }
  return values
}

/**
 * The config for a run: the file named with `--config` (`explicit`, already
 * resolved), which must exist, or else `jev-planner.json` in `dir`, where a
 * missing file just means no config.
 */
export async function findConfig(
  dir: string,
  explicit: string | undefined,
): Promise<LoadedConfig | undefined> {
  const path = explicit ?? join(dir, CONFIG_FILE)
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (explicit === undefined && (error as NodeJS.ErrnoException).code === 'ENOENT')
      return undefined
    throw new Error(`Cannot read the config ${path}: ${(error as Error).message}`, {
      cause: error,
    })
  }
  return { path, values: parseConfig(text, path, explicit !== undefined) }
}
