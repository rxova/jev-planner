import { errorDetail } from './doctor.js'
import type { CheckResult } from './doctor.js'
import { brief, cliProvider, openAICompatibleProvider } from './provider.js'
import type { Provider } from './provider.js'
import { runProcess } from './process.js'

async function claudeAuth(cwd: string): Promise<CheckResult> {
  try {
    const result = await runProcess('claude', ['auth', 'status', '--json'], {
      cwd,
      timeoutMs: 15_000,
    })
    const status = JSON.parse(result.stdout) as {
      loggedIn?: boolean
      authMethod?: string
      subscriptionType?: string
    }
    const detail = [status.authMethod, status.subscriptionType].filter(Boolean).join(', ')
    return {
      name: 'Claude auth',
      ok: status.loggedIn === true,
      detail:
        status.loggedIn === true ? `Logged in${detail ? ` (${detail})` : ''}` : 'Not logged in',
    }
  } catch (error) {
    return { name: 'Claude auth', ok: false, detail: errorDetail(error) }
  }
}

/** One line of `codex exec --json`. */
interface CodexEvent {
  type?: string
  thread_id?: string
  item?: { type?: string; text?: string; command?: string; exit_code?: number | null }
  error?: { message?: string }
  message?: string
}

/** What Codex is doing, from one of its JSON events; its last message is the answer. */
export function codexEvent(event: unknown): {
  progress?: string
  result?: string
  session?: string
} {
  const { type, item, error, message, thread_id: thread } = event as CodexEvent
  // Codex names its own session, and says so first; `exec resume` takes it.
  if (type === 'thread.started') return thread ? { session: thread } : {}
  if (type === 'turn.failed') return { progress: `failed: ${error?.message ?? 'unknown error'}` }
  if (type === 'error') return { progress: `error: ${message ?? 'unknown error'}` }
  if (!item?.type) return {}
  if (type === 'item.started') {
    return item.type === 'command_execution' ? { progress: `$ ${brief(item.command ?? '')}` } : {}
  }
  if (type !== 'item.completed') return {}
  switch (item.type) {
    case 'agent_message':
      return { progress: brief(item.text ?? ''), result: item.text ?? '' }
    case 'reasoning':
      return { progress: brief(item.text ?? '') }
    case 'command_execution':
      return item.exit_code === 0 ? {} : { progress: `exited ${String(item.exit_code)}` }
    default:
      return { progress: item.type.replaceAll('_', ' ') }
  }
}

/** One line of `claude --output-format stream-json`. */
interface ClaudeEvent {
  type?: string
  message?: {
    content?: { type?: string; text?: string; name?: string; input?: Record<string, unknown> }[]
  }
  result?: string
  is_error?: boolean
}

/** What Claude is doing, from one of its JSON events; the `result` event is the answer. */
export function claudeEvent(event: unknown): { progress?: string; result?: string } {
  const { type, message, result, is_error: isError } = event as ClaudeEvent
  if (type === 'result') {
    return isError === true
      ? { progress: `error: ${result ?? 'unknown error'}` }
      : { result: result ?? '' }
  }
  if (type !== 'assistant') return {}
  const lines = (message?.content ?? []).flatMap((block) => {
    if (block.type === 'text') return [brief(block.text ?? '')]
    if (block.type !== 'tool_use') return []
    // The first string argument says what the call is about: a path, a pattern.
    const subject = Object.values(block.input ?? {}).find((value) => typeof value === 'string')
    return [`${block.name ?? 'tool'}${typeof subject === 'string' ? ` ${brief(subject)}` : ''}`]
  })
  return lines.length > 0 ? { progress: lines.join('\n') } : {}
}

interface Overrides {
  model?: string
  effort?: string
}

function codexOverrides({ model, effort }: Overrides): string[] {
  return [
    ...(model ? ['--model', model] : []),
    // A config override, so it wins over model_reasoning_effort in ~/.codex/config.toml.
    ...(effort ? ['-c', `model_reasoning_effort=${JSON.stringify(effort)}`] : []),
  ]
}

/** `codex exec`, read-only, with `session` saying whether its session is kept. */
function codexArgs(session: string[], overrides: Overrides): string[] {
  return [
    'exec',
    '--json',
    ...session,
    '--sandbox',
    'read-only',
    '--skip-git-repo-check',
    '--color',
    'never',
    ...codexOverrides(overrides),
    '-',
  ]
}

/**
 * `claude --print` in plan mode with three read-only tools, whether it starts,
 * continues or keeps no session: `session` says which.
 */
function claudeArgs(session: string[], { model, effort }: Overrides): string[] {
  return [
    '--print',
    '--permission-mode',
    'plan',
    '--permission-prompts',
    'none',
    ...session,
    '--output-format',
    'stream-json',
    // Required by stream-json with --print.
    '--verbose',
    '--tools',
    'Read,Glob,Grep',
    // `--tools` does not reach MCP servers: without this, every server in the
    // user's configuration starts with each call and its tools are callable.
    '--strict-mcp-config',
    ...(model ? ['--model', model] : []),
    ...(effort ? ['--effort', effort] : []),
  ]
}

/**
 * Every AI jev-planner can plan with. To add one, add an entry here, and the
 * agent to `config.schema.json` and its copy in `apps/docs/public/`, which a
 * test keeps in step: the CLI, `doctor`, `--help`, the config, the prompts and
 * Jev all read this list. An OpenAI-compatible chat API is one
 * `openAICompatibleProvider` call; an agent CLI that can run read-only is one
 * `cliProvider` call.
 */
export const PROVIDERS: readonly Provider[] = [
  cliProvider({
    id: 'codex',
    label: 'Codex',
    command: 'codex',
    args: (overrides) => codexArgs(['--ephemeral'], overrides),
    sessions: {
      start: (overrides) => codexArgs([], overrides),
      // `exec resume` has no `--sandbox` and no `--color`: the sandbox is set as
      // config instead, so a resumed session is exactly as read-only.
      resume: (overrides, id) => [
        'exec',
        'resume',
        '--json',
        '--skip-git-repo-check',
        '-c',
        'sandbox_mode="read-only"',
        ...codexOverrides(overrides),
        id,
        '-',
      ],
    },
    effort: true,
    events: codexEvent,
    auth: ['login', 'status'],
  }),
  cliProvider({
    id: 'claude',
    label: 'Claude',
    command: 'claude',
    args: (overrides) => claudeArgs(['--no-session-persistence'], overrides),
    sessions: {
      start: (overrides, id) => claudeArgs(['--session-id', id], overrides),
      resume: (overrides, id) => claudeArgs(['--resume', id], overrides),
    },
    effort: true,
    events: claudeEvent,
    auth: claudeAuth,
  }),
  openAICompatibleProvider({
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    model: 'deepseek-chat',
  }),
  openAICompatibleProvider({
    id: 'kimi',
    label: 'Kimi',
    baseUrl: 'https://api.moonshot.ai/v1',
    apiKeyEnv: 'MOONSHOT_API_KEY',
    model: 'kimi-latest',
  }),
  openAICompatibleProvider({
    id: 'glm',
    label: 'GLM',
    baseUrl: 'https://api.z.ai/api/paas/v4',
    apiKeyEnv: 'ZAI_API_KEY',
    model: 'glm-4.6',
  }),
]

/** The agents a run uses without `--agents`. */
export const DEFAULT_AGENTS = ['codex', 'claude']
