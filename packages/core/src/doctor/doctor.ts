import { runProcess } from '../process/process.js'
import type { Provider } from '../provider/provider.types.js'
import type { CheckResult } from './doctor.types.js'

/** The first line of `text`, trimmed; the whole of a one-line message. */
function firstLine(text: string): string {
  return text.trim().replace(/\n[\s\S]*$/, '')
}

export function errorDetail(error: unknown): string {
  return error instanceof Error ? firstLine(error.message) : String(error)
}

/** Passes when `command args` exits 0; the detail is the first line it printed. */
export async function commandCheck(
  name: string,
  command: string,
  args: readonly string[],
  cwd: string,
): Promise<CheckResult> {
  try {
    const result = await runProcess(command, args, { cwd, timeoutMs: 15_000 })
    return { name, ok: true, detail: firstLine(result.stdout || result.stderr) || 'available' }
  } catch (error) {
    return { name, ok: false, detail: errorDetail(error) }
  }
}

/** Passes when the variable is set to something other than whitespace. Never prints the value. */
export function envCheck(
  name: string,
  variable: string,
  env: Readonly<Record<string, string | undefined>>,
): CheckResult {
  const set = Boolean(env[variable]?.trim())
  return { name, ok: set, detail: `${variable} is ${set ? 'set' : 'not set'}` }
}

/**
 * Each provider's own checks, in order. No paid call. The CLI adds a check for
 * each variable its judge reads (`PlannerProgram.judgeEnv`).
 */
export async function runDoctor(
  cwd: string,
  providers: readonly Provider[],
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<CheckResult[]> {
  const checks = await Promise.all(providers.map((provider) => provider.doctor(cwd, env)))
  return checks.flat()
}
