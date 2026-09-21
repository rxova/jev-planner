import { commandCheck, envCheck } from './doctor.js'
import type { CheckResult } from './doctor.js'
import { runProcess } from './process.js'
import { repoSnapshot } from './repo-context.js'
import type { AgentRequest, PlanningAgent } from './types.js'

type Env = Readonly<Record<string, string | undefined>>

/** What the planner factory hands a provider when it builds an agent for a run. */
export interface AgentSetup {
  /** A model override from `--model <id>=<model>`; the provider's default otherwise. */
  model?: string
  /** Every provider's secret variables, and Jev's: never passed to an agent subprocess. */
  omitEnv: readonly string[]
  env: Env
  /** Replaces the global `fetch`; for tests. */
  fetch?: typeof fetch
}

/**
 * One AI jev-planner can plan with. Build one with `cliProvider` or
 * `openAICompatibleProvider` and add it to `PROVIDERS` in `providers.ts`.
 */
export interface Provider {
  /** Lowercase, what `--agents`, `--model` and `--finalizer` take. */
  readonly id: string
  readonly label: string
  /** `cli` agents read the repository themselves; `api` agents get a snapshot of it. */
  readonly kind: 'cli' | 'api'
  /** Variables holding this provider's credentials, stripped from every agent subprocess. */
  readonly secretEnv: readonly string[]
  create(setup: AgentSetup): PlanningAgent
  /** Local checks only: `jev-planner doctor` never makes a paid call. */
  doctor(cwd: string, env: Env): Promise<CheckResult[]>
}

function requireOutput(label: string, output: string): string {
  const result = output.trim()
  if (!result) throw new Error(`${label} returned an empty response`)
  return result
}

export interface CliProviderConfig {
  id: string
  label: string
  command: string
  /**
   * Arguments for one read-only, non-interactive run that reads the prompt on
   * stdin and prints the answer on stdout.
   */
  args: (model: string | undefined) => string[]
  /**
   * How `doctor` checks the login: arguments to `command` that exit 0 when
   * logged in, or a check of its own.
   */
  auth?: readonly string[] | ((cwd: string) => Promise<CheckResult>)
}

/** An agent CLI installed and logged in on this machine, run read-only in the repository. */
export function cliProvider(config: CliProviderConfig): Provider {
  return {
    id: config.id,
    label: config.label,
    kind: 'cli',
    secretEnv: [],
    create: ({ model, omitEnv }) => ({
      name: config.id,
      label: config.label,
      generate: async (request: AgentRequest) => {
        const { stdout } = await runProcess(config.command, config.args(model), {
          cwd: request.cwd,
          input: request.prompt,
          timeoutMs: request.timeoutMs,
          omitEnv,
        })
        return requireOutput(config.label, stdout)
      },
    }),
    doctor: (cwd) => {
      const checks = [commandCheck(`${config.label} CLI`, config.command, ['--version'], cwd)]
      if (typeof config.auth === 'function') checks.push(config.auth(cwd))
      else if (config.auth) {
        checks.push(commandCheck(`${config.label} auth`, config.command, config.auth, cwd))
      }
      return Promise.all(checks)
    },
  }
}

export interface OpenAICompatibleConfig {
  id: string
  label: string
  /** Up to, not including, `/chat/completions`. */
  baseUrl: string
  /** The variable holding the API key. */
  apiKeyEnv: string
  /** The model used without a `--model` override. */
  model: string
}

/** The instruction an API agent gets in place of the repository access it does not have. */
export const API_AGENT_SYSTEM_PROMPT = `You cannot run commands or open files. The repository snapshot in the task is all
you can see of the codebase: ground the plan in it, and name the files you would need to read wherever
the plan depends on code the snapshot does not show.`

interface ChatCompletion {
  choices?: { message?: { content?: string | null } }[]
}

/**
 * A chat API that speaks OpenAI's `/chat/completions`, as DeepSeek, Moonshot,
 * Z.ai and most others do. It cannot read the repository, so each prompt is
 * sent with a snapshot of it: the tracked file list and the top-level docs and
 * manifests (see `repoSnapshot`).
 */
export function openAICompatibleProvider(config: OpenAICompatibleConfig): Provider {
  const endpoint = `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`
  return {
    id: config.id,
    label: config.label,
    kind: 'api',
    secretEnv: [config.apiKeyEnv],
    create: ({ model = config.model, env, fetch: send = fetch }) => {
      // Built once per run and per directory: every call in a run sees the same snapshot.
      const snapshots = new Map<string, Promise<string>>()
      return {
        name: config.id,
        label: config.label,
        generate: async (request: AgentRequest) => {
          const key = env[config.apiKeyEnv]?.trim()
          if (!key) throw new Error(`${config.apiKeyEnv} is not set, so ${config.label} cannot run`)

          let snapshot = snapshots.get(request.cwd)
          if (!snapshot) {
            snapshot = repoSnapshot(request.cwd)
            snapshots.set(request.cwd, snapshot)
          }

          let response: Response
          try {
            response = await send(endpoint, {
              method: 'POST',
              headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
              body: JSON.stringify({
                model,
                messages: [
                  { role: 'system', content: API_AGENT_SYSTEM_PROMPT },
                  { role: 'user', content: `${await snapshot}\n\n${request.prompt}` },
                ],
              }),
              signal: AbortSignal.timeout(request.timeoutMs),
            })
          } catch (error) {
            if (error instanceof Error && error.name === 'TimeoutError') {
              throw new Error(
                `${config.label} timed out after ${String(request.timeoutMs / 1_000)}s`,
                { cause: error },
              )
            }
            throw error
          }

          if (!response.ok) {
            const detail = (await response.text()).trim().slice(0, 500)
            throw new Error(
              `${config.label} API failed with status ${String(response.status)}${
                detail ? `: ${detail}` : ''
              }`,
            )
          }
          const body = (await response.json()) as ChatCompletion
          return requireOutput(config.label, body.choices?.[0]?.message?.content ?? '')
        },
      }
    },
    doctor: (_cwd, env) =>
      Promise.resolve([envCheck(`${config.label} key`, config.apiKeyEnv, env)]),
  }
}
