import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ClaudeAgent, CodexAgent } from '../agents.js'
import { runProcess } from '../process.js'

vi.mock('../process.js', () => ({ runProcess: vi.fn() }))

const run = vi.mocked(runProcess)
const request = { prompt: 'plan it', cwd: '/repo', timeoutMs: 1_000 }

beforeEach(() => {
  run.mockReset()
  run.mockResolvedValue({ stdout: '  the plan \n', stderr: '', exitCode: 0 })
})

describe('CodexAgent', () => {
  it('runs codex read-only and ephemeral, prompt on stdin, without the Jev key', async () => {
    const agent = new CodexAgent()
    expect(agent.name).toBe('codex')
    await expect(agent.generate(request)).resolves.toBe('the plan')
    expect(run).toHaveBeenCalledWith(
      'codex',
      [
        'exec',
        '--ephemeral',
        '--sandbox',
        'read-only',
        '--skip-git-repo-check',
        '--color',
        'never',
        '-',
      ],
      { cwd: '/repo', input: 'plan it', timeoutMs: 1_000, omitEnv: ['TYPESAFE_API_KEY'] },
    )
  })

  it('passes a model override before the stdin marker', async () => {
    await new CodexAgent('gpt-x').generate(request)
    expect(run.mock.calls[0]?.[1].slice(-3)).toEqual(['--model', 'gpt-x', '-'])
  })

  it('rejects an empty response', async () => {
    run.mockResolvedValue({ stdout: ' \n', stderr: '', exitCode: 0 })
    await expect(new CodexAgent().generate(request)).rejects.toThrow(
      'Codex returned an empty response',
    )
  })
})

describe('ClaudeAgent', () => {
  it('runs claude in plan mode with read-only tools, without the Jev key', async () => {
    const agent = new ClaudeAgent()
    expect(agent.name).toBe('claude')
    await expect(agent.generate(request)).resolves.toBe('the plan')
    const [command, args, options] = run.mock.calls[0]!
    expect(command).toBe('claude')
    expect(args).toContain('--print')
    expect(args.join(' ')).toContain('--permission-mode plan')
    expect(args.join(' ')).toContain('--tools Read,Glob,Grep')
    expect(args).not.toContain('--model')
    expect(options).toEqual({
      cwd: '/repo',
      input: 'plan it',
      timeoutMs: 1_000,
      omitEnv: ['TYPESAFE_API_KEY'],
    })
  })

  it('passes a model override', async () => {
    await new ClaudeAgent('opus').generate(request)
    expect(run.mock.calls[0]?.[1].slice(-2)).toEqual(['--model', 'opus'])
  })

  it('rejects an empty response', async () => {
    run.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 })
    await expect(new ClaudeAgent().generate(request)).rejects.toThrow(
      'Claude returned an empty response',
    )
  })
})
