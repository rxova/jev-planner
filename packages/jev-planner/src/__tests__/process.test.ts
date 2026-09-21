import { describe, expect, it } from 'vitest'
import { ProcessError, runProcess } from '../process.js'

const node = process.execPath
const cwd = process.cwd()

function script(source: string): string[] {
  return ['-e', source]
}

describe('runProcess', () => {
  it('passes input on stdin and resolves both streams', async () => {
    const result = await runProcess(
      node,
      script(
        "process.stdin.on('data', (d) => process.stdout.write(String(d).toUpperCase())); process.stderr.write('note')",
      ),
      { cwd, input: 'plan', timeoutMs: 5_000 },
    )
    expect(result).toEqual({ stdout: 'PLAN', stderr: 'note', exitCode: 0 })
  })

  it('reports each line of both streams as it arrives', async () => {
    const lines: string[] = []
    // "é" is split across two writes, and the last line has no newline.
    const source = [
      "process.stdout.write('first li')",
      "setTimeout(() => process.stdout.write('ne\\r\\n\\n  \\ncaf\\xc3', 'latin1'), 20)",
      'setTimeout(() => process.stdout.write(Buffer.from([0xa9, 0x0a])), 40)',
      "setTimeout(() => { process.stderr.write('working\\n'); process.stdout.write('last') }, 60)",
    ].join('; ')
    const result = await runProcess(node, script(source), {
      cwd,
      timeoutMs: 5_000,
      onLine: (line, stream) => lines.push(`${stream}: ${line}`),
    })
    expect(lines).toEqual(['stdout: first line', 'stdout: café', 'stderr: working', 'stdout: last'])
    expect(result.stdout).toBe('first line\r\n\n  \ncafé\nlast')
  })

  it('can omit secrets from a child environment', async () => {
    const previous = process.env.JEV_PLAN_TEST_SECRET
    process.env.JEV_PLAN_TEST_SECRET = 'do-not-inherit'
    try {
      const result = await runProcess(
        node,
        script("process.stdout.write(process.env.JEV_PLAN_TEST_SECRET || '')"),
        { cwd, omitEnv: ['JEV_PLAN_TEST_SECRET'], timeoutMs: 5_000 },
      )
      expect(result.stdout).toBe('')
    } finally {
      if (previous === undefined) delete process.env.JEV_PLAN_TEST_SECRET
      else process.env.JEV_PLAN_TEST_SECRET = previous
    }
  })

  it('rejects a non-zero exit with a ProcessError carrying stderr', async () => {
    const error = await runProcess(node, script("process.stderr.write('boom'); process.exit(3)"), {
      cwd,
    }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ProcessError)
    expect(error).toMatchObject({ exitCode: 3, stderr: 'boom', name: 'ProcessError' })
    expect((error as Error).message).toBe(`${node} failed with exit code 3:\nboom`)
  })

  it('omits the detail when a failing command wrote no stderr', async () => {
    await expect(runProcess(node, script('process.exit(2)'), { cwd })).rejects.toThrow(
      new RegExp(`failed with exit code 2$`),
    )
  })

  it('reports a signal death without an exit code', async () => {
    const error = await runProcess(node, script("process.kill(process.pid, 'SIGKILL')"), {
      cwd,
    }).catch((caught: unknown) => caught)
    expect(error).toMatchObject({ exitCode: null })
    expect((error as Error).message).toBe(`${node} failed`)
  })

  it('rejects when the command cannot be started', async () => {
    await expect(runProcess('jev-planner-no-such-command', [], { cwd })).rejects.toThrow(
      /^Could not start jev-planner-no-such-command: /,
    )
  })

  it('kills a command that outlives its timeout', async () => {
    await expect(
      runProcess(node, script('setTimeout(() => {}, 10_000)'), { cwd, timeoutMs: 50 }),
    ).rejects.toThrow(`${node} timed out after 50ms`)
  })

  it('kills a command that exceeds the output limit', async () => {
    await expect(
      runProcess(node, script("process.stdout.write('x'.repeat(9 * 1024 * 1024))"), {
        cwd,
        timeoutMs: 10_000,
      }),
    ).rejects.toThrow(`${node} exceeded the 8 MiB output limit`)
  })
})
