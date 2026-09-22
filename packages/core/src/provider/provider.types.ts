import type { CheckResult } from '../doctor/doctor.types.js'

type Env = Readonly<Record<string, string | undefined>>

/** What the planner factory hands a provider when it builds an agent for a run. */
export interface AgentSetup {
  /**
   * The agent's name in the run, for a provider used more than once:
   * `--agents codex:sol` or the config's `agents.sol`. The provider's `id` otherwise.
   */
  name?: string
  /** How prompts, stages and the judge refer to it. `agentLabel` otherwise. */
  label?: string
  /** A model from `--model <name>=<model>` or the config's `agents.<name>.model`; the provider's default otherwise. */
  model?: string
  /** A reasoning effort from `--effort <name>=<level>` or the config; only for a provider whose `effort` is true. */
  effort?: string
  /** Every provider's secret variables, and the judge's: never passed to an agent subprocess. */
  omitEnv: readonly string[]
  env: Env
  /** Replaces the global `fetch`; for tests. */
  fetch?: typeof fetch
}

/**
 * One AI the planner can plan with. Build one with `cliProvider` or
 * `openAICompatibleProvider` and add it to `PROVIDERS` in `providers.ts`.
 */
export interface Provider {
  /**
   * Lowercase, what `--agents` takes, and a key of the config's `agents`. An
   * agent's name defaults to it; a second agent of the same provider is named
   * (`--agents codex:sol,codex:terra`), and `--model` and `--finalizer` take
   * the name.
   */
  readonly id: string
  readonly label: string
  /** `cli` agents read the repository themselves; `api` agents get a snapshot of it. */
  readonly kind: 'cli' | 'api'
  /** Variables holding this provider's credentials, stripped from every agent subprocess. */
  readonly secretEnv: readonly string[]
  /** Whether it takes a reasoning effort, from `--effort` or the config's `agents.<id>.effort`. */
  readonly effort: boolean
  create(setup: AgentSetup): PlanningAgent
  /** Local checks only: `doctor` never makes a paid call. */
  doctor(cwd: string, env: Env): Promise<CheckResult[]>
}

export interface CliProviderConfig {
  id: string
  label: string
  command: string
  /**
   * Arguments for one read-only, non-interactive run that reads the prompt on
   * stdin and prints the answer on stdout. `model` and `effort` are the
   * overrides for this run; each is set only when given, and wins over the
   * CLI's own configuration.
   */
  args: (overrides: { model?: string; effort?: string }) => string[]
  /** Whether `args` passes an effort on, so `--effort` is accepted for it. */
  effort?: boolean
  /**
   * For a CLI whose `args` make it print its work as one JSON event per stdout
   * line: what one event means. `progress` is shown while the agent works, and
   * the last `result` any event gives is the answer. A line that is not JSON is
   * shown as it is. Without `events`, stdout is the answer; either way, each
   * stderr line is progress.
   */
  events?: (event: unknown) => { progress?: string; result?: string; session?: string }
  /**
   * For a CLI that can keep a conversation and continue it in a later call:
   * the arguments for each. Used when the request carries an `AgentSession`;
   * `args` otherwise. Both keep the run read-only, like `args`.
   */
  sessions?: {
    /**
     * The first call, keeping its conversation. `id` is a fresh UUID for a CLI
     * that lets the caller name the session; a CLI that names its own reports
     * the name as an event's `session`.
     */
    start: (overrides: { model?: string; effort?: string }, id: string) => string[]
    /** A later call, continuing the conversation `id`, with the prompt on stdin. */
    resume: (overrides: { model?: string; effort?: string }, id: string) => string[]
  }
  /**
   * How `doctor` checks the login: arguments to `command` that exit 0 when
   * logged in, or a check of its own.
   */
  auth?: readonly string[] | ((cwd: string) => Promise<CheckResult>)
}

export interface OpenAICompatibleConfig {
  id: string
  label: string
  /** Up to, not including, `/chat/completions`. */
  baseUrl: string
  /** The variable holding the API key. */
  apiKeyEnv: string
  /** The model used when neither `--model` nor the config sets one. */
  model: string
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatCompletion {
  choices?: { message?: { content?: string | null } }[]
}

/** An agent's name in a run: its provider id (`codex`, `claude`, …) unless named (`sol`). */
export type AgentName = string

/**
 * One agent's conversation, carried from one stage of a run to the next. The
 * planner creates one per agent per run and passes it on every call to that
 * agent; the provider fills it in on the first call and continues from it on
 * the next ones. An agent that ignores it starts every call afresh.
 */
export interface AgentSession {
  /** The conversation to continue, once a call has started one: a CLI's session or thread id. */
  id?: string
}

export interface AgentRequest {
  /** The whole prompt, for an agent that starts afresh. */
  prompt: string
  /**
   * The same request for an agent continuing `session`, which already holds
   * the task and its own earlier plans: `prompt` without them. `prompt` is used
   * when this is absent or the conversation cannot be continued.
   */
  resumePrompt?: string
  /** Continue this conversation, when the agent can; see `AgentSession`. */
  session?: AgentSession
  /**
   * A reasoning effort for this call only, over the one the agent was created
   * with. An agent that takes no effort ignores it.
   */
  effort?: string
  cwd: string
  timeoutMs: number
  /** Called with a line about the agent's work as it happens: a message, a command, a file read. */
  onProgress?: (line: string) => void
  /** Aborted when the run no longer needs this answer, so the agent stops working and stops billing. */
  signal?: AbortSignal
}

export interface PlanningAgent {
  /**
   * Unique in a run: what `--finalizer`, the judge's verdict, objection ids and the
   * rounds files use. Its provider id, unless named (`--agents codex:sol`).
   */
  readonly name: AgentName
  /**
   * How prompts, stages, the plan and the judge refer to it: `Codex`, `DeepSeek`, or
   * `Codex (sol)` for a named one. Keep labels unique too: the judge tells plans
   * apart by label.
   */
  readonly label: string
  /**
   * Whether the agent opens files in the repository itself, as an agent CLI
   * does. Only such agents check disputed claims in `debate` review; an agent
   * that leaves this out is treated as one that does not.
   */
  readonly readsRepository?: boolean
  generate(request: AgentRequest): Promise<string>
}
