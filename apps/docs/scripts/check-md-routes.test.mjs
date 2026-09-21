import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { FORBIDDEN, checkMdRoutes, isUntwinned, twinFor } from './check-md-routes.mjs'

/** Write a throwaway dist tree: `{ 'a/index.html': '…' }`. */
async function dist(files) {
  const dir = await mkdtemp(join(tmpdir(), 'jev-planner-docs-'))
  for (const [path, body] of Object.entries(files)) {
    const full = join(dir, path)
    await mkdir(dirname(full), { recursive: true })
    await writeFile(full, body)
  }
  return dir
}

const PREFIX = 'https://rxova.org/packages/jev-planner'

/** A twin whose `source:` frontmatter pins the site prefix the checker reads back. */
const twin = (route, body = 'Body.') =>
  ['---', `title: "${route}"`, `source: ${PREFIX}/${route}/`, '---', '', body, ''].join('\n')

const page = (title = 'Page') => `<!doctype html><title>${title}</title><p>Hi.</p>`

describe('twinFor', () => {
  it.each([
    ['index.html', 'index.md'],
    ['guides/serialization/index.html', 'guides/serialization.md'],
  ])('%s -> %s', (html, md) => {
    expect(twinFor(html)).toBe(md)
  })
})

describe('isUntwinned', () => {
  it('excludes only Astro 404', () => {
    expect(isUntwinned('404.html')).toBe(true)
    expect(isUntwinned('guides/serialization/index.html')).toBe(false)
  })
})

describe('FORBIDDEN', () => {
  it('is made of real patterns, none of which match an empty string', () => {
    // A regex that matches everything reports every twin; one that matches
    // nothing silently stops checking. Both look like a passing build.
    for (const [pattern, why] of FORBIDDEN) {
      expect(pattern, why).toBeInstanceOf(RegExp)
      expect(pattern.test(''), why).toBe(false)
    }
  })
})

describe('checkMdRoutes', () => {
  it('passes a well-formed build', async () => {
    const dir = await dist({
      'index.html': page(),
      'index.md': twin('index'),
      'guides/serialization/index.html': page(),
      'guides/serialization.md': twin('guides/serialization'),
      '404.html': page('404'),
    })

    const { failures, twins } = await checkMdRoutes(dir)

    expect(failures).toEqual([])
    expect(twins).toBe(2)
  })

  it('reports a page with no twin', async () => {
    const dir = await dist({
      'index.md': twin('index'),
      'guides/serialization/index.html': page(),
      'reference/api.md': twin('reference/api'),
      'reference/api/index.html': page(),
    })

    const { failures } = await checkMdRoutes(dir)

    expect(failures).toEqual([
      'guides/serialization/index.html has no markdown twin at guides/serialization.md',
    ])
  })

  it('skips a redirect stub, which has no content to twin', async () => {
    const dir = await dist({
      'old/index.html': '<meta http-equiv="refresh" content="0;url=/new/">',
      'reference/api/index.html': page(),
      'reference/api.md': twin('reference/api'),
    })

    expect((await checkMdRoutes(dir)).failures).toEqual([])
  })

  it('reports unhandled markup, and only outside a fence', async () => {
    const dir = await dist({
      'reference/api.md': twin('reference/api', '<TabItem label="npm">'),
      'reference/types.md': twin(
        'reference/types',
        ['```md', '<TabItem label="npm">', 'see [x](/reference/api/)', '```'].join('\n'),
      ),
    })

    const { failures } = await checkMdRoutes(dir)

    expect(failures).toHaveLength(1)
    expect(failures[0]).toContain('reference/api.md')
    expect(failures[0]).toContain('an unhandled Starlight/MDX component')
  })

  it('reports a link to a twin that does not exist', async () => {
    // The one a build cannot notice: `./why.md` from a page that is not in
    // `learn/` is a well-formed link nothing else reads.
    const dir = await dist({
      'learn/why.md': twin('learn/why', `[api](${PREFIX}/reference/api.md)`),
    })

    expect((await checkMdRoutes(dir)).failures).toEqual([
      'learn/why.md links to reference/api.md, which is not a twin',
    ])
  })

  it('accepts a link to a twin that does exist', async () => {
    const dir = await dist({
      'learn/why.md': twin('learn/why', `[api](${PREFIX}/reference/api.md#exit-codes)`),
      'reference/api.md': twin('reference/api'),
    })

    expect((await checkMdRoutes(dir)).failures).toEqual([])
  })

  it('reports twins it cannot pin a site prefix from', async () => {
    // Without the prefix the link check silently stops running, which is the
    // failure this whole script exists to avoid.
    const dir = await dist({ 'reference/api.md': '# No frontmatter here.\n' })

    expect((await checkMdRoutes(dir)).failures).toEqual([
      'could not determine the site prefix from any twin\'s "source:" frontmatter',
    ])
  })

  it('reports llms-full.txt over budget', async () => {
    const dir = await dist({
      'reference/api.md': twin('reference/api'),
      'llms-full.txt': 'x'.repeat(801 * 1024),
    })

    const { failures } = await checkMdRoutes(dir)

    expect(failures).toHaveLength(1)
    expect(failures[0]).toContain('llms-full.txt is 801 kB')
  })

  it('says nothing about budgets when the endpoints are absent', async () => {
    // Keeps the script usable against a build that predates them.
    const dir = await dist({ 'reference/api.md': twin('reference/api') })

    expect((await checkMdRoutes(dir)).failures).toEqual([])
  })
})
