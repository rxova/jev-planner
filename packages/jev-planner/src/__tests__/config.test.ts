import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CONFIG_FILE, CONFIG_KEYS, findConfig, parseConfig } from '../config.js'
import { PROVIDERS } from '../providers.js'

const PATH = '/repo/jev-planner.json'

/** A config's values from `settings`, as a discovered file unless `explicit`. */
const parse = (settings: unknown, explicit = false) =>
  parseConfig(JSON.stringify(settings), PATH, explicit)

const rejects = (settings: unknown, message: string, explicit = false) => {
  expect(() => parse(settings, explicit)).toThrow(`${PATH}: ${message}`)
}

describe('parseConfig', () => {
  it('turns every key into the value of the flag it stands for, with paths absolute', () => {
    expect(
      parse(
        {
          $schema: 'https://jev-planner.com/config.schema.json',
          agents: {
            codex: { model: 'gpt-5.6-sol', effort: 'high', reviewEffort: 'low' },
            claude: { model: ' claude-fable-5-1 ' },
            deepseek: {},
          },
          mode: 'ultra',
          reviewMode: 'debate',
          reviewRounds: 1,
          claimChecks: true,
          finalizer: 'none',
          jevModel: 'jev-test',
          stragglerGrace: 0,
          timeout: 120.5,
          resume: false,
          rounds: true,
          json: true,
          verbose: false,
          allowAnyTask: true,
          runsDir: 'runs',
          output: '../PLAN.md',
          cwd: 'app',
          taskFile: 'TASK.md',
        },
        true,
      ),
    ).toEqual({
      agents: 'codex,claude,deepseek',
      model: ['codex=gpt-5.6-sol', 'claude=claude-fable-5-1'],
      effort: ['codex=high'],
      'review-effort': ['codex=low'],
      mode: 'ultra',
      'review-mode': 'debate',
      'review-rounds': '1',
      'claim-checks': true,
      finalizer: 'none',
      'jev-model': 'jev-test',
      'straggler-grace': '0',
      timeout: '120.5',
      resume: false,
      rounds: true,
      json: true,
      verbose: false,
      'allow-any-task': true,
      runsDir: '/repo/runs',
      output: '/PLAN.md',
      cwd: '/repo/app',
      taskFile: '/repo/TASK.md',
    })
  })

  it('reads an empty object as no settings, and a task as it is written', () => {
    expect(parse({})).toEqual({ model: [], effort: [], 'review-effort': [] })
    expect(parse({ task: ' Add caching ' }).task).toBe('Add caching')
  })

  it('strips a leading byte-order mark', () => {
    expect(parseConfig('﻿{"mode":"fast"}', PATH, false).mode).toBe('fast')
  })

  it('names the file in a JSON syntax error', () => {
    expect(() => parseConfig('{"mode": }', PATH, false)).toThrow(`${PATH}: not valid JSON: `)
  })

  it('needs an object at the top level', () => {
    for (const settings of [[], null, 'mode', 1]) {
      rejects(settings, 'the top level: must be an object')
    }
  })

  it('rejects an unknown key, and lists the ones it knows', () => {
    rejects({ modes: 'fast' }, `modes: unknown key. Expected one of ${CONFIG_KEYS.join(', ')}.`)
    rejects({ constructor: 1 }, 'constructor: unknown key.')
  })

  it('rejects a key that looks like a secret, and names where secrets go instead', () => {
    for (const key of ['apiKey', 'TYPESAFE_API_KEY', 'token', 'clientSecret', 'password']) {
      rejects({ [key]: 'x' }, `${key}: a config never holds a secret`)
    }
    rejects(
      { agents: { codex: {}, deepseek: { apiKey: 'x' } } },
      'agents.deepseek.apiKey: a config never holds a secret; it is meant to be committed. ' +
        'Set TYPESAFE_API_KEY, DEEPSEEK_API_KEY',
    )
  })

  it('checks each type, and names the key', () => {
    rejects({ mode: 'slow' }, 'mode: must be one of "fast", "balanced", "ultra"')
    rejects({ reviewMode: 'loud' }, 'reviewMode: must be one of "standard", "debate"')
    rejects({ reviewRounds: 3 }, 'reviewRounds: must be one of 0, 1, 2')
    rejects({ reviewRounds: '1' }, 'reviewRounds: must be one of 0, 1, 2')
    rejects({ json: 'yes' }, 'json: must be true or false')
    rejects({ finalizer: '  ' }, 'finalizer: must be a non-empty string')
    rejects({ output: 7 }, 'output: must be a non-empty string')
    rejects({ timeout: 0 }, 'timeout: must be a positive number of seconds')
    rejects({ timeout: '600' }, 'timeout: must be a positive number of seconds')
    rejects({ stragglerGrace: -1 }, 'stragglerGrace: must be a number of seconds, 0 or more')
  })

  it('checks the agents: two or more known ones, each with known, non-empty settings', () => {
    rejects({ agents: ['codex', 'claude'] }, 'agents: must be an object')
    rejects({ agents: { codex: {} } }, 'agents: needs at least two agents')
    rejects(
      { agents: { codex: {}, gemini: {} } },
      `agents.gemini: unknown agent. Expected one of ${PROVIDERS.map(({ id }) => id).join(', ')}.`,
    )
    rejects({ agents: { codex: {}, claude: 'opus' } }, 'agents.claude: must be an object')
    rejects(
      { agents: { codex: { models: 'x' }, claude: {} } },
      'agents.codex.models: unknown key. Expected one of model, effort, reviewEffort.',
    )
    rejects(
      { agents: { codex: {}, claude: { model: '' } } },
      'agents.claude.model: must be a non-empty string',
    )
  })

  it('takes an effort only for an agent that has one', () => {
    rejects(
      { agents: { codex: {}, deepseek: { effort: 'high' } } },
      'agents.deepseek.effort: DeepSeek does not take effort',
    )
    rejects(
      { agents: { codex: {}, kimi: { reviewEffort: 'low' } } },
      'agents.kimi.reviewEffort: Kimi does not take effort',
    )
  })

  it('runs one provider as several named agents, keyed by name', () => {
    expect(
      parse({
        agents: {
          sol: { provider: 'codex', model: 'gpt-5.6-sol', effort: 'high' },
          Terra: { provider: 'codex', reviewEffort: 'low' },
          deepseek: {},
          chat: { provider: 'deepseek', model: 'deepseek-reasoner' },
        },
      }),
    ).toMatchObject({
      agents: 'codex:sol,codex:terra,deepseek,deepseek:chat',
      model: ['sol=gpt-5.6-sol', 'chat=deepseek-reasoner'],
      effort: ['sol=high'],
      'review-effort': ['terra=low'],
    })
  })

  it('checks a named agent: its provider, and a name the run can use', () => {
    const ids = PROVIDERS.map(({ id }) => JSON.stringify(id)).join(', ')
    rejects(
      { agents: { codex: { provider: 'claude' }, claude: {} } },
      'agents.codex.provider: a provider key names its own provider; use another key for an instance',
    )
    rejects(
      { agents: { sol: { provider: 'gemini' }, claude: {} } },
      `agents.sol.provider: must be one of ${ids}`,
    )
    rejects(
      { agents: { sol: { provider: 7 }, claude: {} } },
      `agents.sol.provider: must be one of ${ids}`,
    )
    rejects(
      { agents: { sol: {}, claude: {} } },
      'agents.sol: unknown agent. Expected one of codex, claude, deepseek, kimi, glm. A named agent sets "provider".',
    )
    rejects(
      { agents: { tie: { provider: 'codex' }, claude: {} } },
      'agents.tie: a reserved word, not an agent name',
    )
    rejects(
      { agents: { Auto: { provider: 'codex' }, claude: {} } },
      'agents.auto: a reserved word, not an agent name',
    )
    rejects(
      { agents: { Claude: { provider: 'codex' }, codex: {} } },
      'agents.claude: the name of another provider, not an agent name',
    )
    rejects(
      { agents: { '9lives': { provider: 'codex' }, claude: {} } },
      'agents.9lives: an agent name is a letter, then letters, digits or -, at most 24 characters',
    )
    rejects(
      { agents: { sol: { provider: 'codex' }, SOL: { provider: 'claude' } } },
      'agents.SOL: sol is listed more than once',
    )
    rejects(
      { agents: { sol: { provider: 'codex', models: 'x' }, claude: {} } },
      'agents.sol.models: unknown key. Expected one of provider, model, effort, reviewEffort.',
    )
  })

  it('takes an effort under a name only when its provider has one', () => {
    rejects(
      { agents: { codex: {}, chat: { provider: 'deepseek', effort: 'high' } } },
      'agents.chat.effort: DeepSeek does not take effort',
    )
  })

  it('takes cwd only from a file passed with --config', () => {
    rejects({ cwd: 'app' }, 'cwd: allowed only in a file passed with --config')
    expect(parse({ cwd: 'app' }, true).cwd).toBe('/repo/app')
  })

  it('rejects settings that contradict each other', () => {
    rejects({ task: 'Add caching', taskFile: 'TASK.md' }, 'task and taskFile: set one, not both')
    rejects({ runsDir: 'runs', rounds: false }, 'runsDir and rounds: false: set one, not both')
    expect(parse({ runsDir: 'runs', rounds: true }).runsDir).toBe('/repo/runs')
  })
})

describe('findConfig', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'jev-planner-config-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it(`reads ${CONFIG_FILE} from the folder`, async () => {
    await writeFile(join(dir, CONFIG_FILE), '{"mode":"fast"}')
    await expect(findConfig(dir, undefined)).resolves.toEqual({
      path: join(dir, CONFIG_FILE),
      values: { model: [], effort: [], 'review-effort': [], mode: 'fast' },
    })
  })

  it('finds nothing, silently, when the folder has no config', async () => {
    await expect(findConfig(dir, undefined)).resolves.toBeUndefined()
  })

  it('reports a config it finds but cannot read', async () => {
    await mkdir(join(dir, CONFIG_FILE))
    await expect(findConfig(dir, undefined)).rejects.toThrow(
      `Cannot read the config ${join(dir, CONFIG_FILE)}: `,
    )
  })

  it('needs the file passed with --config to exist, and lets it set cwd', async () => {
    const path = join(dir, 'other.json')
    await expect(findConfig(dir, path)).rejects.toThrow(`Cannot read the config ${path}: ENOENT`)
    await writeFile(path, '{"cwd":"."}')
    await expect(findConfig('/elsewhere', path)).resolves.toMatchObject({
      path,
      values: { cwd: dir },
    })
  })
})

describe('config.schema.json', () => {
  const read = async (path: string) =>
    JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8')) as {
      properties: Record<string, unknown>
    }

  it('lists the keys the config reads', async () => {
    const schema = await read('../../config.schema.json')
    expect(Object.keys(schema.properties).sort()).toEqual([...CONFIG_KEYS].sort())
  })

  it('lists every agent, with an effort only where the agent takes one', async () => {
    const { properties } = await read('../../config.schema.json')
    const agents = (properties.agents as { properties: Record<string, { properties: object }> })
      .properties
    expect(Object.keys(agents)).toEqual(PROVIDERS.map(({ id }) => id))
    for (const provider of PROVIDERS) {
      expect(Object.keys(agents[provider.id]?.properties ?? {})).toEqual(
        provider.effort ? ['model', 'effort', 'reviewEffort'] : ['model'],
      )
    }
  })

  it('takes a named agent of any provider, with an effort only where the provider takes one', async () => {
    const { properties } = await read('../../config.schema.json')
    const named = (
      properties.agents as {
        additionalProperties: {
          properties: { provider: { enum: string[] } }
          if: { properties: { provider: { enum: string[] } } }
        }
      }
    ).additionalProperties
    expect(named.properties.provider.enum).toEqual(PROVIDERS.map(({ id }) => id))
    expect(named.if.properties.provider.enum).toEqual(
      PROVIDERS.filter(({ effort }) => !effort).map(({ id }) => id),
    )
  })

  it('is the copy the docs site serves, byte for byte', async () => {
    const shipped = new URL('../../config.schema.json', import.meta.url)
    const hosted = new URL('../../../../apps/docs/public/config.schema.json', import.meta.url)
    expect(await readFile(hosted, 'utf8')).toBe(await readFile(shipped, 'utf8'))
  })
})
