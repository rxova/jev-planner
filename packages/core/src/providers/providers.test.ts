import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runProcess } from '../process/process.js'
import { claudeEvent, codexEvent, DEFAULT_AGENTS, PROVIDERS } from './providers.js'
import type { Provider } from '../provider/provider.types.js'

vi.mock('../process/process.js', () => ({ runProcess: vi.fn() }))

const run = vi.mocked(runProcess)
const request = { prompt: 'plan it', cwd: '/repo', timeoutMs: 1_000 }
const setup = { omitEnv: ['TYPESAFE_API_KEY', 'DEEPSEEK_API_KEY'], env: {} }

function provider(id: string): Provider {
  const found = PROVIDERS.find((candidate) => candidate.id === id)
  if (!found) throw new Error(`no provider ${id}`)
  return found
}

/** A rejection with a non-Error reason: what the `String(error)` fallback is for. */
function rejectWith(reason: unknown): Promise<never> {
  // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the point of the test
  return Promise.reject(reason)
}

/** Makes the next agent process print these lines, as runProcess reports them. */
function prints(stdout: readonly unknown[], stderr: readonly string[] = []) {
  run.mockImplementation((_command, _args, options) => {
    const lines = stdout.map((line) => (typeof line === 'string' ? line : JSON.stringify(line)))
    for (const line of lines) options.onLine?.(line, 'stdout')
    for (const line of stderr) options.onLine?.(line, 'stderr')
    return Promise.resolve({ stdout: lines.join('\n'), stderr: stderr.join('\n'), exitCode: 0 })
  })
}

const codexAnswer = (text: string) => ({
  type: 'item.completed',
  item: { type: 'agent_message', text },
})
const claudeAnswer = (result: string) => ({ type: 'result', result, is_error: false })

beforeEach(() => {
  run.mockReset()
})

describe('PROVIDERS', () => {
  it('has unique lowercase ids, and the defaults are among them', () => {
    const ids = PROVIDERS.map(({ id }) => id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(id).toMatch(/^[a-z][a-z0-9-]*$/)
    for (const id of DEFAULT_AGENTS) expect(ids).toContain(id)
    expect(DEFAULT_AGENTS).toEqual(['codex', 'claude'])
  })

  it('declares a secret for every API agent', () => {
    for (const { kind, secretEnv } of PROVIDERS) {
      if (kind === 'api') expect(secretEnv).not.toHaveLength(0)
    }
  })
})

describe('codex', () => {
  beforeEach(() => {
    prints([codexAnswer('  the plan \n')])
  })

  it('runs codex read-only and ephemeral, prompt on stdin, without the secrets', async () => {
    const agent = provider('codex').create(setup)
    expect(agent).toMatchObject({ name: 'codex', label: 'Codex' })
    await expect(agent.generate(request)).resolves.toBe('the plan')
    expect(run).toHaveBeenCalledWith(
      'codex',
      [
        'exec',
        '--json',
        '--ephemeral',
        '--sandbox',
        'read-only',
        '--skip-git-repo-check',
        '--color',
        'never',
        '-',
      ],
      {
        cwd: '/repo',
        input: 'plan it',
        timeoutMs: 1_000,
        omitEnv: setup.omitEnv,
        onLine: expect.any(Function),
      },
    )
  })

  it('passes a model override before the stdin marker', async () => {
    await provider('codex')
      .create({ ...setup, model: 'gpt-x' })
      .generate(request)
    expect(run.mock.calls[0]?.[1].slice(-3)).toEqual(['--model', 'gpt-x', '-'])
  })

  it('overrides the configured reasoning effort', async () => {
    const codex = provider('codex')
    expect(codex.effort).toBe(true)
    await codex.create({ ...setup, model: 'gpt-5.6-terra', effort: 'low' }).generate(request)
    expect(run.mock.calls[0]?.[1].slice(-5)).toEqual([
      '--model',
      'gpt-5.6-terra',
      '-c',
      'model_reasoning_effort="low"',
      '-',
    ])
  })

  it('answers with its last message, and reports its work as it goes', async () => {
    prints(
      [
        { type: 'thread.started' },
        codexAnswer('I will read the docs app first.'),
        { type: 'item.started', item: { type: 'command_execution', command: 'ls apps/docs' } },
        codexAnswer('# Plan\n\nStep one'),
      ],
      ['a warning'],
    )
    const progress: string[] = []
    const plan = await provider('codex')
      .create(setup)
      .generate({ ...request, onProgress: (line) => progress.push(line) })
    expect(plan).toBe('# Plan\n\nStep one')
    expect(progress).toEqual([
      'I will read the docs app first.',
      '$ ls apps/docs',
      '# Plan',
      'a warning',
    ])
  })

  it('keeps its session, and resumes it read-only with the same overrides', async () => {
    prints([{ type: 'thread.started', thread_id: 'thread-1' }, codexAnswer('plan')])
    const agent = provider('codex').create({ ...setup, model: 'gpt-x', effort: 'low' })
    const session: { id?: string } = {}
    await agent.generate({ ...request, session })
    expect(session.id).toBe('thread-1')
    await agent.generate({ ...request, resumePrompt: 'short', session })

    const [start, resume] = run.mock.calls.map(([, args]) => args)
    expect(start).not.toContain('--ephemeral')
    expect(start?.join(' ')).toContain('--sandbox read-only')
    expect(resume).toEqual([
      'exec',
      'resume',
      '--json',
      '--skip-git-repo-check',
      '-c',
      'sandbox_mode="read-only"',
      '--model',
      'gpt-x',
      '-c',
      'model_reasoning_effort="low"',
      'thread-1',
      '-',
    ])
    expect(run.mock.calls[1]?.[2].input).toBe('short')
  })

  it('never resumes a session without the read-only sandbox', async () => {
    prints([codexAnswer('plan')])
    await provider('codex')
      .create(setup)
      .generate({ ...request, session: { id: 'thread-1' } })
    const args = run.mock.calls[0]?.[1] ?? []
    expect(args.slice(0, 2)).toEqual(['exec', 'resume'])
    expect(args[args.indexOf('sandbox_mode="read-only"') - 1]).toBe('-c')
    expect(args.some((arg) => arg.includes('danger') || arg.includes('bypass'))).toBe(false)
  })

  it('rejects an empty response', async () => {
    prints([{ type: 'turn.completed' }])
    await expect(provider('codex').create(setup).generate(request)).rejects.toThrow(
      'Codex returned an empty response',
    )
  })

  it('checks the CLI and its login', async () => {
    run.mockImplementation((_command, args) =>
      args[0] === 'login'
        ? Promise.reject(new Error('Not logged in'))
        : Promise.resolve({ stdout: 'codex-cli 1', stderr: '', exitCode: 0 }),
    )
    await expect(provider('codex').doctor('/repo', {})).resolves.toEqual([
      { name: 'Codex CLI', ok: true, detail: 'codex-cli 1' },
      { name: 'Codex auth', ok: false, detail: 'Not logged in' },
    ])
    expect(run).toHaveBeenCalledWith('codex', ['login', 'status'], {
      cwd: '/repo',
      timeoutMs: 15_000,
    })
  })
})

describe('claude', () => {
  beforeEach(() => {
    prints([claudeAnswer('  the plan \n')])
  })

  it('runs claude in plan mode with read-only tools, without the secrets', async () => {
    const agent = provider('claude').create(setup)
    expect(agent).toMatchObject({ name: 'claude', label: 'Claude' })
    await expect(agent.generate(request)).resolves.toBe('the plan')
    const [command, args, options] = run.mock.calls[0]!
    expect(command).toBe('claude')
    expect(args).toContain('--print')
    expect(args.join(' ')).toContain('--permission-mode plan')
    expect(args.join(' ')).toContain('--tools Read,Glob,Grep')
    // Otherwise the user's MCP servers start too, and their tools are callable.
    expect(args).toContain('--strict-mcp-config')
    expect(args.join(' ')).toContain('--output-format stream-json --verbose')
    expect(args).not.toContain('--model')
    expect(options).toEqual({
      cwd: '/repo',
      input: 'plan it',
      timeoutMs: 1_000,
      omitEnv: setup.omitEnv,
      onLine: expect.any(Function),
    })
  })

  it('answers with the result event, and shows a line that is not JSON as it is', async () => {
    prints([
      { type: 'system', subtype: 'init' },
      {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'a.ts' } }] },
      },
      'not json',
      claudeAnswer('the plan'),
    ])
    const progress: string[] = []
    await expect(
      provider('claude')
        .create(setup)
        .generate({ ...request, onProgress: (line) => progress.push(line) }),
    ).resolves.toBe('the plan')
    expect(progress).toEqual(['Read a.ts', 'not json'])
  })

  it('starts a named session, and resumes it in plan mode with the same read-only tools', async () => {
    const claude = provider('claude')
    await claude.create({ ...setup, effort: 'high' }).generate(request)
    const agent = claude.create({ ...setup, effort: 'high' })
    const session: { id?: string } = {}
    await agent.generate({ ...request, session })
    await agent.generate({ ...request, resumePrompt: 'short', session })
    const [plain = [], start = [], resume = []] = run.mock.calls.map(([, args]) => [...args])
    const id = String(session.id)

    expect(id).toMatch(/^[0-9a-f-]{36}$/)
    expect(plain).toContain('--no-session-persistence')
    expect(run.mock.calls[2]?.[2].input).toBe('short')
    // Each is the plain call with only its session flags swapped in.
    const swap = (flags: string[]) =>
      plain.map((arg) => (arg === '--no-session-persistence' ? flags : [arg])).flat()
    expect(start).toEqual(swap(['--session-id', id]))
    expect(resume).toEqual(swap(['--resume', id]))
  })

  it('passes a model override', async () => {
    await provider('claude')
      .create({ ...setup, model: 'opus' })
      .generate(request)
    expect(run.mock.calls[0]?.[1].slice(-2)).toEqual(['--model', 'opus'])
  })

  it('passes an effort override', async () => {
    const claude = provider('claude')
    expect(claude.effort).toBe(true)
    await claude.create({ ...setup, effort: 'low' }).generate(request)
    expect(run.mock.calls[0]?.[1].slice(-2)).toEqual(['--effort', 'low'])
  })

  describe('auth check', () => {
    function authWith(status: () => Promise<{ stdout: string; stderr: string; exitCode: number }>) {
      run.mockImplementation((_command, args) =>
        args[0] === 'auth' ? status() : Promise.resolve({ stdout: '2', stderr: '', exitCode: 0 }),
      )
      return provider('claude').doctor('/repo', {})
    }
    const out = (stdout: string) => () => Promise.resolve({ stdout, stderr: '', exitCode: 0 })

    it('reports a login with its method and plan', async () => {
      const loggedIn = { loggedIn: true, authMethod: 'oauth', subscriptionType: 'max' }
      await expect(authWith(out(JSON.stringify(loggedIn)))).resolves.toEqual([
        { name: 'Claude CLI', ok: true, detail: '2' },
        { name: 'Claude auth', ok: true, detail: 'Logged in (oauth, max)' },
      ])
    })

    it('reports a login without plan details', async () => {
      const checks = await authWith(out(JSON.stringify({ loggedIn: true })))
      expect(checks[1]).toEqual({ name: 'Claude auth', ok: true, detail: 'Logged in' })
    })

    it('reports no login', async () => {
      const checks = await authWith(out(JSON.stringify({ loggedIn: false })))
      expect(checks[1]).toEqual({ name: 'Claude auth', ok: false, detail: 'Not logged in' })
    })

    it('reports an unreadable status', async () => {
      const checks = await authWith(out('not json'))
      expect(checks[1]).toMatchObject({ name: 'Claude auth', ok: false })
      expect(checks[1]?.detail).toMatch(/JSON/)
    })

    it('reports a non-Error failure', async () => {
      const checks = await authWith(() => rejectWith(42))
      expect(checks[1]).toEqual({ name: 'Claude auth', ok: false, detail: '42' })
    })
  })
})

describe('codexEvent', () => {
  it('describes messages, reasoning, commands and other items', () => {
    const done = (item: object) => codexEvent({ type: 'item.completed', item })
    expect(done({ type: 'agent_message', text: 'Plan\nmore' })).toEqual({
      progress: 'Plan',
      result: 'Plan\nmore',
    })
    expect(done({ type: 'agent_message' })).toEqual({ progress: '', result: '' })
    expect(done({ type: 'reasoning', text: 'Thinking about caching' })).toEqual({
      progress: 'Thinking about caching',
    })
    expect(done({ type: 'reasoning' })).toEqual({ progress: '' })
    expect(done({ type: 'command_execution', exit_code: 0 })).toEqual({})
    expect(done({ type: 'command_execution', exit_code: 2 })).toEqual({ progress: 'exited 2' })
    expect(done({ type: 'web_search' })).toEqual({ progress: 'web search' })
    expect(codexEvent({ type: 'item.started', item: { type: 'command_execution' } })).toEqual({
      progress: '$ ',
    })
    expect(codexEvent({ type: 'item.started', item: { type: 'reasoning' } })).toEqual({})
    expect(codexEvent({ type: 'item.updated', item: { type: 'todo_list' } })).toEqual({})
    expect(codexEvent({ type: 'turn.started' })).toEqual({})
  })

  it('reports the thread id as the session', () => {
    expect(codexEvent({ type: 'thread.started', thread_id: 'abc' })).toEqual({ session: 'abc' })
    expect(codexEvent({ type: 'thread.started' })).toEqual({})
  })

  it('reports failures', () => {
    expect(codexEvent({ type: 'turn.failed', error: { message: 'quota' } })).toEqual({
      progress: 'failed: quota',
    })
    expect(codexEvent({ type: 'turn.failed' })).toEqual({ progress: 'failed: unknown error' })
    expect(codexEvent({ type: 'error', message: 'reconnecting' })).toEqual({
      progress: 'error: reconnecting',
    })
    expect(codexEvent({ type: 'error' })).toEqual({ progress: 'error: unknown error' })
  })
})

describe('claudeEvent', () => {
  const says = (...content: object[]) => claudeEvent({ type: 'assistant', message: { content } })

  it('describes text and tool calls, and skips the rest', () => {
    expect(
      says(
        { type: 'text', text: 'Reading the docs app.\nThen the workflows.' },
        { type: 'thinking', thinking: 'hidden' },
        { type: 'tool_use', name: 'Grep', input: { limit: 3, pattern: 'deploy' } },
        { type: 'tool_use', name: 'Glob', input: {} },
        { type: 'tool_use' },
        { type: 'text' },
      ),
    ).toEqual({ progress: 'Reading the docs app.\nGrep deploy\nGlob\ntool\n' })
    expect(says({ type: 'thinking', thinking: 'hidden' })).toEqual({})
    expect(claudeEvent({ type: 'assistant' })).toEqual({})
    expect(claudeEvent({ type: 'system', subtype: 'init' })).toEqual({})
  })

  it('takes the answer from the result event, and reports an error result', () => {
    expect(claudeEvent({ type: 'result', result: 'the plan' })).toEqual({ result: 'the plan' })
    expect(claudeEvent({ type: 'result' })).toEqual({ result: '' })
    expect(claudeEvent({ type: 'result', is_error: true, result: 'overloaded' })).toEqual({
      progress: 'error: overloaded',
    })
    expect(claudeEvent({ type: 'result', is_error: true })).toEqual({
      progress: 'error: unknown error',
    })
  })
})
