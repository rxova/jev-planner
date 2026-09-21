import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runProcess } from '../process.js'
import { API_AGENT_SYSTEM_PROMPT, cliProvider, openAICompatibleProvider } from '../provider.js'
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

describe('cliProvider', () => {
  const config = { id: 'tool', label: 'Tool', command: 'tool', args: () => ['run'] }

  it('is a CLI provider with no secrets of its own', () => {
    expect(cliProvider(config)).toMatchObject({
      id: 'tool',
      label: 'Tool',
      kind: 'cli',
      secretEnv: [],
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
    expect(provider).toMatchObject({ id: 'acme', kind: 'api', secretEnv: ['ACME_API_KEY'] })
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
