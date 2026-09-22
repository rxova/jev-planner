import { randomUUID } from 'node:crypto'
import { commandCheck, envCheck } from './doctor.js'
import type { CheckResult } from './doctor.js'
import { ProcessError, runProcess } from './process.js'
import { repoSnapshot } from './repo-context.js'
import type { AgentRequest, AgentSession, PlanningAgent } from './types.js'

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

/** One line of progress from a longer text: its first non-blank line, clipped. */
export function brief(text: string, max = 160): string {
  const line = text.trim().split('\n', 1)[0]?.trim() ?? ''
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`
}

/**
 * An agent's label: the provider's own for an agent named after it, `Codex (sol)`
 * for a named one, so two agents of one provider never share a label, which is
 * how the judge and the prompts tell plans apart.
 */
export function agentLabel(provider: { id: string; label: string }, name: string): string {
  return name === provider.id ? provider.label : `${provider.label} (${name})`
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

/** An agent CLI installed and logged in on this machine, run read-only in the repository. */
export function cliProvider(config: CliProviderConfig): Provider {
  return {
    id: config.id,
    label: config.label,
    kind: 'cli',
    secretEnv: [],
    effort: config.effort ?? false,
    create: ({ name = config.id, label = agentLabel(config, name), model, effort, omitEnv }) => ({
      name,
      label,
      // It runs in the repository, so it can open a file to check a claim.
      readsRepository: true,
      generate: async (request: AgentRequest) => {
        const callEffort = config.effort ? (request.effort ?? effort) : effort
        const overrides = {
          ...(model === undefined ? {} : { model }),
          ...(callEffort === undefined ? {} : { effort: callEffort }),
        }
        const { events, sessions } = config
        const read = (line: string, stream: 'stdout' | 'stderr') => {
          if (stream === 'stderr') return { progress: line }
          if (!events) return {}
          let event: unknown
          try {
            event = JSON.parse(line)
          } catch {
            return { progress: line }
          }
          return events(event)
        }
        const once = async (args: string[], input: string) => {
          let answer = ''
          let session: string | undefined
          const { stdout } = await runProcess(config.command, args, {
            cwd: request.cwd,
            input,
            timeoutMs: request.timeoutMs,
            omitEnv,
            ...(request.signal ? { signal: request.signal } : {}),
            onLine: (line, stream) => {
              const event = read(line, stream)
              if (event.progress) request.onProgress?.(event.progress)
              if (event.result !== undefined) answer = event.result
              if (event.session !== undefined) session = event.session
            },
          })
          return { answer: requireOutput(label, events ? answer : stdout), session }
        }
        const { session } = request
        if (!sessions || !session)
          return (await once(config.args(overrides), request.prompt)).answer

        // Kept only once a call succeeds, so a failed start is never resumed.
        const start = async (conversation: AgentSession) => {
          const id = randomUUID()
          const result = await once(sessions.start(overrides, id), request.prompt)
          conversation.id = result.session ?? id
          return result.answer
        }
        if (session.id === undefined) return start(session)
        try {
          return (
            await once(
              sessions.resume(overrides, session.id),
              request.resumePrompt ?? request.prompt,
            )
          ).answer
        } catch (error) {
          // A session the CLI no longer has, or a CLI too old to resume: start
          // afresh with the whole prompt rather than fail the run. A timeout is
          // not a failed resume, so it still ends the call.
          if (!(error instanceof ProcessError)) throw error
          // The CLI's own reason is usually its last word on stderr.
          const reason = brief(error.stderr.trim().split('\n').at(-1) ?? '') || error.message
          request.onProgress?.(
            `Could not continue the earlier session (${brief(reason)}); starting a new one`,
          )
          return start(session)
        }
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
  /** The model used when neither `--model` nor the config sets one. */
  model: string
}

/** The instruction an API agent gets in place of the repository access it does not have. */
export const API_AGENT_SYSTEM_PROMPT = `You cannot run commands or open files. The repository snapshot in the task is all
you can see of the codebase: ground the plan in it, and name the files you would need to read wherever
the plan depends on code the snapshot does not show.`

interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

interface ChatCompletion {
  choices?: { message?: { content?: string | null } }[]
}

/**
 * A chat API that speaks OpenAI's `/chat/completions`, as DeepSeek, Moonshot,
 * Z.ai and most others do. It cannot read the repository, so each prompt is
 * sent with a snapshot of it: the tracked file list and the top-level docs and
 * manifests (see `repoSnapshot`). Given an `AgentSession`, it keeps the
 * conversation and sends it back on the next call, so the snapshot is sent once
 * and later prompts can leave out what the conversation already holds.
 */
export function openAICompatibleProvider(config: OpenAICompatibleConfig): Provider {
  const endpoint = `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`
  return {
    id: config.id,
    label: config.label,
    kind: 'api',
    secretEnv: [config.apiKeyEnv],
    // Each API spells reasoning effort its own way, if at all.
    effort: false,
    create: ({
      name = config.id,
      label = agentLabel(config, name),
      model = config.model,
      env,
      fetch: send = fetch,
    }) => {
      // Built once per run and per directory: every call in a run sees the same snapshot.
      const snapshots = new Map<string, Promise<string>>()
      // Each session's messages so far, the answers included.
      const conversations = new WeakMap<AgentSession, ChatMessage[]>()
      return {
        name,
        label,
        // It sees a snapshot of the repository, not the repository: it cannot check a claim.
        readsRepository: false,
        generate: async (request: AgentRequest) => {
          const key = env[config.apiKeyEnv]?.trim()
          if (!key) throw new Error(`${config.apiKeyEnv} is not set, so ${label} cannot run`)

          const earlier = request.session && conversations.get(request.session)
          let messages: ChatMessage[]
          if (earlier) {
            messages = [
              ...earlier,
              { role: 'user', content: request.resumePrompt ?? request.prompt },
            ]
          } else {
            let snapshot = snapshots.get(request.cwd)
            if (!snapshot) {
              snapshot = repoSnapshot(request.cwd)
              snapshots.set(request.cwd, snapshot)
            }
            messages = [
              { role: 'system', content: API_AGENT_SYSTEM_PROMPT },
              { role: 'user', content: `${await snapshot}\n\n${request.prompt}` },
            ]
          }

          request.onProgress?.(`Waiting for ${model} to answer…`)
          const timeout = AbortSignal.timeout(request.timeoutMs)
          // The request ends at the timeout, or as soon as the run stops needing it.
          const signal = request.signal ? AbortSignal.any([timeout, request.signal]) : timeout
          let response: Response
          try {
            response = await send(endpoint, {
              method: 'POST',
              headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
              body: JSON.stringify({ model, messages }),
              signal,
            })
          } catch (error) {
            if (request.signal?.aborted === true) {
              throw new Error(`${label} was stopped: the run no longer needs it`, {
                cause: error,
              })
            }
            if (error instanceof Error && error.name === 'TimeoutError') {
              throw new Error(`${label} timed out after ${String(request.timeoutMs / 1_000)}s`, {
                cause: error,
              })
            }
            throw error
          }

          if (!response.ok) {
            const detail = (await response.text()).trim().slice(0, 500)
            throw new Error(
              `${label} API failed with status ${String(response.status)}${
                detail ? `: ${detail}` : ''
              }`,
            )
          }
          const body = (await response.json()) as ChatCompletion
          const answer = requireOutput(label, body.choices?.[0]?.message?.content ?? '')
          if (request.session) {
            conversations.set(request.session, [
              ...messages,
              { role: 'assistant', content: answer },
            ])
          }
          return answer
        },
      }
    },
    doctor: (_cwd, env) =>
      Promise.resolve([envCheck(`${config.label} key`, config.apiKeyEnv, env)]),
  }
}
