import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'

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
    /** Called with each non-blank line of either stream as it arrives, before the process ends. */
    onLine?: (line: string, stream: 'stdout' | 'stderr') => void
    /** Kills the process when the caller stops needing its output. */
    signal?: AbortSignal
  },
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted === true) {
      reject(new Error(`${command} was not started: the run no longer needs it`))
      return
    }
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

    // One decoder per stream, so a character split across two chunks is not garbled.
    const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') }
    const partial = { stdout: '', stderr: '' }
    const emit = (stream: 'stdout' | 'stderr', chunk?: Buffer): void => {
      const { onLine } = options
      if (!onLine) return
      const text = chunk ? decoders[stream].write(chunk) : decoders[stream].end()
      const lines = `${partial[stream]}${text}`.split(/\r?\n/)
      // Mid-stream, the last piece is an unfinished line; at the end, it is the last line.
      partial[stream] = chunk ? (lines.pop() ?? '') : ''
      for (const line of lines) if (line.trim()) onLine(line, stream)
    }

    const finish = (callback: () => void): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      options.signal?.removeEventListener('abort', abort)
      callback()
    }

    const abort = (): void => {
      child.kill('SIGTERM')
      finish(() => {
        reject(new Error(`${command} was stopped: the run no longer needs it`))
      })
    }
    options.signal?.addEventListener('abort', abort)

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
      emit('stdout', chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      collect(stderr, chunk)
      emit('stderr', chunk)
    })

    child.on('error', (error) => {
      finish(() => {
        reject(new Error(`Could not start ${command}: ${error.message}`, { cause: error }))
      })
    })

    child.on('close', (exitCode) => {
      if (!settled) {
        emit('stdout')
        emit('stderr')
      }
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
