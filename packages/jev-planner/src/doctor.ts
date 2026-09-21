import { runProcess } from './process.js'

export interface CheckResult {
  name: string
  ok: boolean
  detail: string
}

/** The first line of `text`, trimmed; the whole of a one-line message. */
function firstLine(text: string): string {
  return text.trim().replace(/\n[\s\S]*$/, '')
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? firstLine(error.message) : String(error)
}

async function commandCheck(
  name: string,
  command: string,
  args: readonly string[],
  cwd: string,
): Promise<CheckResult> {
  try {
    const result = await runProcess(command, args, { cwd, timeoutMs: 15_000 })
    return { name, ok: true, detail: firstLine(result.stdout || result.stderr) || 'available' }
  } catch (error) {
    return {
      name,
      ok: false,
      detail: errorDetail(error),
    }
  }
}

async function claudeAuthCheck(cwd: string): Promise<CheckResult> {
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
    return {
      name: 'Claude auth',
      ok: false,
      detail: errorDetail(error),
    }
  }
}

export async function runDoctor(cwd: string): Promise<CheckResult[]> {
  const [codexVersion, codexAuth, claudeVersion, claudeAuth] = await Promise.all([
    commandCheck('Codex CLI', 'codex', ['--version'], cwd),
    commandCheck('Codex auth', 'codex', ['login', 'status'], cwd),
    commandCheck('Claude CLI', 'claude', ['--version'], cwd),
    claudeAuthCheck(cwd),
  ])

  return [
    codexVersion,
    codexAuth,
    claudeVersion,
    claudeAuth,
    {
      name: 'TypeSafe key',
      ok: Boolean(process.env.TYPESAFE_API_KEY?.trim()),
      detail: process.env.TYPESAFE_API_KEY?.trim()
        ? 'TYPESAFE_API_KEY is set'
        : 'TYPESAFE_API_KEY is not set',
    },
  ]
}
