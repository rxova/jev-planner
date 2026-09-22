import { readFile } from 'node:fs/promises'
import { CONFIG_KEYS, PROVIDERS } from '@rxova/planner-core'
import { describe, expect, it } from 'vitest'

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
