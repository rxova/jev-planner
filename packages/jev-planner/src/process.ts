import { spawn } from 'node:child_process'

const MAX_OUTPUT_BYTES = 8 * 1024 * 1024

export class ProcessError extends Error {
  readonly command: string
  readonly exitCode: number | null
  readonly stderr: string

  constructor(command: string, exitCode: number | null, stderr: string) {
    const detail = stderr.trim().slice(-2_000)
    super(
      `${command} failed${exitCode === null ? '' : ` with exit code ${String(exitCode)}`}${
        detail ? `:\n${detail}` : ''
      }`,
    )
    this.name = 'ProcessError'
    this.command = command
    this.exitCode = exitCode
    this.stderr = stderr
  }
}

export interface ProcessResult {
  stdout: string
  stderr: string
  exitCode: number
}

export function runProcess(
  command: string,
  args: readonly string[],
  options: {
    cwd: string
    input?: string
    timeoutMs?: number
    omitEnv?: readonly string[]
  },
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const omit = new Set(options.omitEnv)
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !omit.has(name)))
    const child = spawn(command, args, {
      cwd: options.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let outputBytes = 0
    let settled = false

    const finish = (callback: () => void): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      callback()
    }

    const collect = (target: Buffer[], chunk: Buffer): void => {
      outputBytes += chunk.length
      if (outputBytes > MAX_OUTPUT_BYTES) {
        child.kill('SIGTERM')
        finish(() => {
          reject(new Error(`${command} exceeded the 8 MiB output limit`))
        })
        return
      }
      target.push(chunk)
    }

    child.stdout.on('data', (chunk: Buffer) => {
      collect(stdout, chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      collect(stderr, chunk)
    })

    child.on('error', (error) => {
      finish(() => {
        reject(new Error(`Could not start ${command}: ${error.message}`, { cause: error }))
      })
    })

    child.on('close', (exitCode) => {
      finish(() => {
        const result = {
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
          exitCode: exitCode ?? 1,
        }
        if (exitCode !== 0) {
          reject(new ProcessError(command, exitCode, result.stderr))
          return
        }
        resolve(result)
      })
    })

    const timer =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            child.kill('SIGTERM')
            finish(() => {
              reject(new Error(`${command} timed out after ${String(options.timeoutMs)}ms`))
            })
          }, options.timeoutMs)

    child.stdin.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EPIPE') {
        finish(() => {
          reject(error)
        })
      }
    })
    child.stdin.end(options.input)
  })
}
