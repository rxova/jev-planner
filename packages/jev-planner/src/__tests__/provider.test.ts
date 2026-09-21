import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runProcess } from '../process.js'
import {
  API_AGENT_SYSTEM_PROMPT,
  brief,
  cliProvider,
  openAICompatibleProvider,
} from '../provider.js'
import { repoSnapshot } from '../repo-context.js'

vi.mock('../process.js', () => ({ runProcess: vi.fn() }))
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
