import { randomUUID } from 'node:crypto'
import { commandCheck, envCheck } from '../doctor/doctor.js'
import { ProcessError, runProcess } from '../process/process.js'
import { repoSnapshot } from '../repo-context/repo-context.js'
import type { AgentRequest, AgentSession } from './provider.types.js'
import type {
  Provider,
  CliProviderConfig,
  OpenAICompatibleConfig,
  ChatMessage,
  ChatCompletion,
} from './provider.types.js'

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

/** The instruction an API agent gets in place of the repository access it does not have. */
export const API_AGENT_SYSTEM_PROMPT = `You cannot run commands or open files. The repository snapshot in the task is all
you can see of the codebase: ground the plan in it, and name the files you would need to read wherever
the plan depends on code the snapshot does not show.`

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
