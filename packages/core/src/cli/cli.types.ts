import type { PlanOptions, PlanResult } from '../orchestrator/orchestrator.types.js'
import type { Provider } from '../provider/provider.types.js'
import type { CheckResult } from '../doctor/doctor.types.js'

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
