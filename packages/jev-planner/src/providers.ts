import { errorDetail } from './doctor.js'
import type { CheckResult } from './doctor.js'
import { cliProvider, openAICompatibleProvider } from './provider.js'
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

/**
 * Every AI jev-planner can plan with. To add one, add an entry here — that is
 * the whole change: the CLI, `doctor`, `--help`, the prompts and Jev all read
 * this list. An OpenAI-compatible chat API is one `openAICompatibleProvider`
 * call; an agent CLI that can run read-only is one `cliProvider` call.
 */
export const PROVIDERS: readonly Provider[] = [
  cliProvider({
    id: 'codex',
    label: 'Codex',
    command: 'codex',
    args: ({ model, effort }) => [
      'exec',
      '--ephemeral',
      '--sandbox',
      'read-only',
      '--skip-git-repo-check',
      '--color',
      'never',
      ...(model ? ['--model', model] : []),
      // A config override, so it wins over model_reasoning_effort in ~/.codex/config.toml.
      ...(effort ? ['-c', `model_reasoning_effort=${JSON.stringify(effort)}`] : []),
      '-',
    ],
    effort: true,
    auth: ['login', 'status'],
  }),
  cliProvider({
    id: 'claude',
    label: 'Claude',
    command: 'claude',
    args: ({ model, effort }) => [
      '--print',
      '--permission-mode',
      'plan',
      '--permission-prompts',
      'none',
      '--no-session-persistence',
      '--output-format',
      'text',
      '--tools',
      'Read,Glob,Grep',
      ...(model ? ['--model', model] : []),
      ...(effort ? ['--effort', effort] : []),
    ],
    effort: true,
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
