import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ProcessError, runProcess } from '../process.js'
import type * as processModule from '../process.js'
import {
  API_AGENT_SYSTEM_PROMPT,
  brief,
  cliProvider,
  openAICompatibleProvider,
} from '../provider.js'
import { repoSnapshot } from '../repo-context.js'

vi.mock('../process.js', async (importOriginal) => ({
  ...(await importOriginal<typeof processModule>()),
  runProcess: vi.fn(),
}))
vi.mock('../repo-context.js', () => ({ repoSnapshot: vi.fn() }))

const run = vi.mocked(runProcess)
const snapshot = vi.mocked(repoSnapshot)
const request = { prompt: 'plan it', cwd: '/repo', timeoutMs: 2_000 }

beforeEach(() => {
  run.mockReset()
  snapshot.mockReset()
  snapshot.mockResolvedValue('<repository-snapshot/>')
})

describe('brief', () => {
  it('keeps the first non-blank line, clipped', () => {
    expect(brief('\n  first line  \nsecond')).toBe('first line')
    expect(brief('abcdef', 4)).toBe('abc…')
    expect(brief('abcd', 4)).toBe('abcd')
    expect(brief('   ')).toBe('')
  })
})

describe('cliProvider', () => {
  const config = { id: 'tool', label: 'Tool', command: 'tool', args: () => ['run'] }

  it('is a CLI provider with no secrets of its own, and no effort unless it says so', () => {
    expect(cliProvider(config)).toMatchObject({
      id: 'tool',
      label: 'Tool',
      kind: 'cli',
      secretEnv: [],
      effort: false,
    })
    expect(cliProvider({ ...config, effort: true }).effort).toBe(true)
  })

  it('hands args only the overrides that were given', async () => {
    run.mockResolvedValue({ stdout: 'plan', stderr: '', exitCode: 0 })
    const args = vi.fn(() => ['run'])
    const tool = cliProvider({ ...config, args })
    await tool.create({ omitEnv: [], env: {} }).generate(request)
    await tool.create({ omitEnv: [], env: {}, model: 'm', effort: 'low' }).generate(request)
    expect(args.mock.calls).toEqual([[{}], [{ model: 'm', effort: 'low' }]])
  })

  it("lets one call's effort win over the agent's, when the CLI takes an effort", async () => {
    run.mockResolvedValue({ stdout: 'plan', stderr: '', exitCode: 0 })
    const args = vi.fn(() => ['run'])
    const setup = { omitEnv: [], env: {}, effort: 'xhigh' }
    const withEffort = cliProvider({ ...config, args, effort: true }).create(setup)
    await withEffort.generate(request)
    await withEffort.generate({ ...request, effort: 'low' })
    await cliProvider({ ...config, args })
      .create({ omitEnv: [], env: {} })
      .generate({ ...request, effort: 'low' })
    expect(args.mock.calls).toEqual([[{ effort: 'xhigh' }], [{ effort: 'low' }], [{}]])
  })

  it('passes an abort signal on to the process, and nothing when there is none', async () => {
    run.mockResolvedValue({ stdout: 'plan', stderr: '', exitCode: 0 })
    const agent = cliProvider(config).create({ omitEnv: [], env: {} })
    const signal = AbortSignal.timeout(5_000)

    await agent.generate({ ...request, signal })
    await agent.generate(request)

    expect(run.mock.calls[0]?.[2]).toMatchObject({ signal })
    expect(run.mock.calls[1]?.[2]).not.toHaveProperty('signal')
  })

  it('reads events from stdout: progress as it comes, the last result as the answer', async () => {
    run.mockImplementation((_command, _args, options) => {
      for (const line of ['{"say":"step"}', '{"answer":"first"}', 'plain', '{"answer":"final"}']) {
        options.onLine?.(line, 'stdout')
      }
      options.onLine?.('warning', 'stderr')
      return Promise.resolve({ stdout: 'raw events', stderr: 'warning', exitCode: 0 })
    })
    const events = (event: unknown) => {
      const { say, answer } = event as { say?: string; answer?: string }
      return { ...(say ? { progress: say } : {}), ...(answer ? { result: answer } : {}) }
    }
    const progress: string[] = []
    const plan = await cliProvider({ ...config, events })
      .create({ omitEnv: [], env: {} })
      .generate({ ...request, onProgress: (line) => progress.push(line) })
    expect(plan).toBe('final')
    expect(progress).toEqual(['step', 'plain', 'warning'])
  })

  it('without events, answers with stdout and reports only stderr lines', async () => {
    run.mockImplementation((_command, _args, options) => {
      options.onLine?.('the plan', 'stdout')
      options.onLine?.('thinking', 'stderr')
      return Promise.resolve({ stdout: 'the plan', stderr: 'thinking', exitCode: 0 })
    })
    const progress: string[] = []
    const agent = cliProvider(config).create({ omitEnv: [], env: {} })
    await expect(
      agent.generate({ ...request, onProgress: (line) => progress.push(line) }),
    ).resolves.toBe('the plan')
    await expect(agent.generate(request)).resolves.toBe('the plan')
    expect(progress).toEqual(['thinking'])
  })

  describe('sessions', () => {
    const sessions = {
      start: (_overrides: object, id: string) => ['start', id],
      resume: (_overrides: object, id: string) => ['resume', id],
    }
    const answering = (answer = 'plan') =>
      Promise.resolve({ stdout: answer, stderr: '', exitCode: 0 })
    const argsOf = () => run.mock.calls.map(([, args]) => args)
    const inputsOf = () => run.mock.calls.map(([, , options]) => options.input)

    it('starts a named session, then resumes it with the shorter prompt', async () => {
      run.mockImplementation(() => answering())
      const agent = cliProvider({ ...config, sessions }).create({ omitEnv: [], env: {} })
      const session: { id?: string } = {}
      await agent.generate({ ...request, session })
      const id = session.id
      expect(id).toMatch(/^[0-9a-f-]{36}$/)
      await agent.generate({ ...request, prompt: 'whole', resumePrompt: 'short', session })
      await agent.generate({ ...request, prompt: 'whole again', session })
      expect(argsOf()).toEqual([
        ['start', id],
        ['resume', id],
        ['resume', id],
      ])
      expect(inputsOf()).toEqual(['plan it', 'short', 'whole again'])
      expect(session.id).toBe(id)
    })

    it('keeps the session id the CLI reports in place of its own', async () => {
      run.mockImplementation((_command, _args, options) => {
        options.onLine?.('{"thread":"t-1"}', 'stdout')
        options.onLine?.('{"answer":"plan"}', 'stdout')
        return answering('events')
      })
      const events = (event: unknown) => {
        const { thread, answer } = event as { thread?: string; answer?: string }
        return { ...(thread ? { session: thread } : {}), ...(answer ? { result: answer } : {}) }
      }
      const agent = cliProvider({ ...config, events, sessions }).create({ omitEnv: [], env: {} })
      const session: { id?: string } = {}
      await expect(agent.generate({ ...request, session })).resolves.toBe('plan')
      expect(session.id).toBe('t-1')
      await agent.generate({ ...request, session })
      expect(argsOf()[1]).toEqual(['resume', 't-1'])
    })

    it('keeps no id from a start that failed', async () => {
      run.mockRejectedValueOnce(new ProcessError('tool', 1, 'boom'))
      const agent = cliProvider({ ...config, sessions }).create({ omitEnv: [], env: {} })
      const session: { id?: string } = {}
      await expect(agent.generate({ ...request, session })).rejects.toThrow(ProcessError)
      expect(session).toEqual({})
    })

    it('starts afresh with the whole prompt when a resume fails, and says so', async () => {
      run
        .mockRejectedValueOnce(new ProcessError('tool', 1, 'no such session\nmore'))
        .mockImplementation(() => answering('fresh plan'))
      const agent = cliProvider({ ...config, sessions }).create({ omitEnv: [], env: {} })
      const session = { id: 'gone' }
      const progress: string[] = []
      await expect(
        agent.generate({
          ...request,
          prompt: 'whole',
          resumePrompt: 'short',
          session,
          onProgress: (line) => progress.push(line),
        }),
      ).resolves.toBe('fresh plan')
      expect(argsOf()).toEqual([
        ['resume', 'gone'],
        ['start', session.id],
      ])
      expect(session.id).not.toBe('gone')
      expect(inputsOf()).toEqual(['short', 'whole'])
      expect(progress).toEqual([
        'Could not continue the earlier session (more); starting a new one',
      ])
    })

    it('gives the exit when a failed resume printed nothing', async () => {
      run
        .mockRejectedValueOnce(new ProcessError('tool', 2, ''))
        .mockImplementation(() => answering())
      const progress: string[] = []
      await cliProvider({ ...config, sessions })
        .create({ omitEnv: [], env: {} })
        .generate({
          ...request,
          session: { id: 'gone' },
          onProgress: (line) => progress.push(line),
        })
      expect(progress).toEqual([
        'Could not continue the earlier session (tool failed with exit code 2); starting a new one',
      ])
    })

    it('does not retry a resume that timed out', async () => {
      run.mockRejectedValueOnce(new Error('tool timed out after 2000ms'))
      const agent = cliProvider({ ...config, sessions }).create({ omitEnv: [], env: {} })
      await expect(agent.generate({ ...request, session: { id: 'slow' } })).rejects.toThrow(
        'timed out',
      )
      expect(run).toHaveBeenCalledOnce()
    })

    it('ignores the session without session arguments, and uses args without a session', async () => {
      run.mockImplementation(() => answering())
      const session: { id?: string } = {}
      await cliProvider(config)
        .create({ omitEnv: [], env: {} })
        .generate({ ...request, resumePrompt: 'short', session })
      await cliProvider({ ...config, sessions })
        .create({ omitEnv: [], env: {} })
        .generate({ ...request, resumePrompt: 'short' })
      expect(argsOf()).toEqual([['run'], ['run']])
      expect(inputsOf()).toEqual(['plan it', 'plan it'])
      expect(session).toEqual({})
    })
  })

  it('checks only the CLI when it has no auth check', async () => {
    run.mockResolvedValue({ stdout: 'tool 1', stderr: '', exitCode: 0 })
    await expect(cliProvider(config).doctor('/repo', {})).resolves.toEqual([
      { name: 'Tool CLI', ok: true, detail: 'tool 1' },
    ])
  })
})

describe('openAICompatibleProvider', () => {
  const provider = openAICompatibleProvider({
    id: 'acme',
    label: 'Acme',
    baseUrl: 'https://api.acme.test/v1/',
    apiKeyEnv: 'ACME_API_KEY',
    model: 'acme-default',
  })
  const env = { ACME_API_KEY: ' sk-test ' }

  function completion(content: string | null): Response {
    return Response.json({ choices: [{ message: { content } }] })
  }

  function agentWith(send: typeof fetch, model?: string) {
    return provider.create({
      env,
      omitEnv: [],
      fetch: send,
      ...(model === undefined ? {} : { model }),
    })
  }

  it('declares its key as a secret', () => {
    expect(provider).toMatchObject({
      id: 'acme',
      kind: 'api',
      secretEnv: ['ACME_API_KEY'],
      effort: false,
    })
  })

  it('posts the snapshot and prompt to /chat/completions with the key', async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(completion('  the plan \n'))
    const agent = agentWith(send)
    expect(agent).toMatchObject({ name: 'acme', label: 'Acme' })
    await expect(agent.generate(request)).resolves.toBe('the plan')

    const [url, init] = send.mock.calls[0]!
    expect(url).toBe('https://api.acme.test/v1/chat/completions')
    expect(init?.method).toBe('POST')
    expect(init?.headers).toEqual({
      'content-type': 'application/json',
      authorization: 'Bearer sk-test',
    })
    expect(init?.signal).toBeInstanceOf(AbortSignal)
    expect(JSON.parse(init?.body as string)).toEqual({
      model: 'acme-default',
      messages: [
        { role: 'system', content: API_AGENT_SYSTEM_PROMPT },
        { role: 'user', content: '<repository-snapshot/>\n\nplan it' },
      ],
    })
    expect(snapshot).toHaveBeenCalledWith('/repo')
  })

  it('says which model it is waiting on', async () => {
    const progress: string[] = []
    await agentWith(vi.fn<typeof fetch>().mockResolvedValue(completion('ok'))).generate({
      ...request,
      onProgress: (line) => progress.push(line),
    })
    expect(progress).toEqual(['Waiting for acme-default to answer…'])
  })

  it('uses a model override, and snapshots each directory once per agent', async () => {
    const send = vi.fn<typeof fetch>().mockImplementation(() => Promise.resolve(completion('ok')))
    const agent = agentWith(send, 'acme-large')
    await agent.generate(request)
    await agent.generate(request)
    await agent.generate({ ...request, cwd: '/other' })
    expect(JSON.parse(send.mock.calls[0]?.[1]?.body as string)).toMatchObject({
      model: 'acme-large',
    })
    expect(snapshot.mock.calls).toEqual([['/repo'], ['/other']])
  })

  it('continues a session: the snapshot once, then the earlier messages and the short prompt', async () => {
    const send = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(completion('draft'))
      .mockResolvedValueOnce(completion('revised'))
      .mockResolvedValueOnce(completion('other'))
    const agent = agentWith(send)
    const session = {}
    await agent.generate({ ...request, session })
    await agent.generate({ ...request, prompt: 'whole', resumePrompt: 'short', session })
    await agent.generate({ ...request, prompt: 'no session', resumePrompt: 'short' })
    const bodies = send.mock.calls.map(
      ([, init]) => JSON.parse(init?.body as string) as { messages: unknown[] },
    )
    expect(bodies[1]?.messages).toEqual([
      { role: 'system', content: API_AGENT_SYSTEM_PROMPT },
      { role: 'user', content: '<repository-snapshot/>\n\nplan it' },
      { role: 'assistant', content: 'draft' },
      { role: 'user', content: 'short' },
    ])
    expect(bodies[2]?.messages).toEqual([
      { role: 'system', content: API_AGENT_SYSTEM_PROMPT },
      { role: 'user', content: '<repository-snapshot/>\n\nno session' },
    ])
    expect(snapshot).toHaveBeenCalledOnce()
  })

  it('falls back to the whole prompt when a session has no earlier messages', async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(completion('ok'))
    await agentWith(send).generate({
      ...request,
      prompt: 'whole',
      resumePrompt: 'short',
      session: {},
    })
    expect(JSON.parse(send.mock.calls[0]?.[1]?.body as string)).toMatchObject({
      messages: [{ role: 'system' }, { role: 'user', content: '<repository-snapshot/>\n\nwhole' }],
    })
  })

  it('refuses to run without its key', async () => {
    const send = vi.fn<typeof fetch>()
    const agent = provider.create({ env: { ACME_API_KEY: ' ' }, omitEnv: [], fetch: send })
    await expect(agent.generate(request)).rejects.toThrow(
      'ACME_API_KEY is not set, so Acme cannot run',
    )
    expect(send).not.toHaveBeenCalled()
  })

  it('reports a failed response with the start of its body', async () => {
    const body = `rate limited ${'x'.repeat(600)}`
    const agent = agentWith(() => Promise.resolve(new Response(body, { status: 429 })))
    await expect(agent.generate(request)).rejects.toThrow(
      `Acme API failed with status 429: ${body.slice(0, 500)}`,
    )
    const bare = agentWith(() => Promise.resolve(new Response('', { status: 500 })))
    await expect(bare.generate(request)).rejects.toThrow(/^Acme API failed with status 500$/)
  })

  it('rejects an empty or missing answer', async () => {
    await expect(
      agentWith(() => Promise.resolve(completion(null))).generate(request),
    ).rejects.toThrow('Acme returned an empty response')
    await expect(
      agentWith(() => Promise.resolve(Response.json({}))).generate(request),
    ).rejects.toThrow('Acme returned an empty response')
  })

  it('reports a timeout in seconds, and passes other failures through', async () => {
    const timeout = new DOMException('The operation timed out.', 'TimeoutError')
    await expect(agentWith(() => Promise.reject(timeout)).generate(request)).rejects.toThrow(
      'Acme timed out after 2s',
    )
    await expect(
      agentWith(() => Promise.reject(new TypeError('fetch failed'))).generate(request),
    ).rejects.toThrow('fetch failed')
  })

  it('ends the request when the run stops needing the answer', async () => {
    const controller = new AbortController()
    const send = vi.fn<typeof fetch>(async (_url, init) => {
      controller.abort()
      init?.signal?.throwIfAborted()
      return completion('plan')
    })

    await expect(
      agentWith(send).generate({ ...request, signal: controller.signal }),
    ).rejects.toThrow('Acme was stopped: the run no longer needs it')
  })

  it('uses the global fetch by default', async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(completion('plan'))
    vi.stubGlobal('fetch', send)
    try {
      await expect(provider.create({ env, omitEnv: [] }).generate(request)).resolves.toBe('plan')
      expect(send).toHaveBeenCalledOnce()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('checks the key without printing it', async () => {
    await expect(provider.doctor('/repo', env)).resolves.toEqual([
      { name: 'Acme key', ok: true, detail: 'ACME_API_KEY is set' },
    ])
    await expect(provider.doctor('/repo', {})).resolves.toEqual([
      { name: 'Acme key', ok: false, detail: 'ACME_API_KEY is not set' },
    ])
  })
})
