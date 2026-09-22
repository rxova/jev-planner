/**
 * What a config depends on besides its text: the one file the CLI looks for
 * in the repository, `<program>.json`, not a dotfile so it is not taken for run
 * output; and the variables the judge reads, which a config must never hold.
 */
export interface ConfigSetup {
  file: string
  judgeEnv: readonly string[]
}

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
  'judge-model'?: string
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

/** Where a config's relative paths start, and the variables it must not hold besides the providers'. */
export interface Context {
  dir: string
  judgeEnv: readonly string[]
}
