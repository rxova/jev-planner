import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  BUDGETS,
  REQUIRED,
  baseProblems,
  checkSiteBuild,
  eagerAssets,
  metaProblems,
  pngSize,
  prefixFrom,
  staticImports,
} from './check-site-build.mjs'

/** Write a throwaway dist tree: `{ 'a/index.html': '…' }`. */
async function dist(files) {
  const dir = await mkdtemp(join(tmpdir(), 'jev-planner-site-'))
  for (const [path, body] of Object.entries(files)) {
    const full = join(dir, path)
    await mkdir(dirname(full), { recursive: true })
    await writeFile(full, body)
  }
  return dir
}

/** A PNG header with the given size — all the checker reads. */
function png(width, height) {
  const buffer = Buffer.alloc(33)
  Buffer.from('89504e470d0a1a0a', 'hex').copy(buffer)
  buffer.writeUInt32BE(width, 16)
  buffer.writeUInt32BE(height, 20)
  return buffer
}

const PREFIX = 'https://example.com/sub'
const BASE = '/sub/'
const VERSION = '1.2.3'

const head = (path = '') =>
  `<link rel="canonical" href="${PREFIX}/${path}">` +
  `<meta property="og:url" content="${PREFIX}/${path}">` +
  `<meta property="og:image" content="${PREFIX}/og.png">` +
  `<link rel="stylesheet" href="${BASE}_astro/site.css">` +
  `<script type="module" src="${BASE}_astro/page.js"></script>`

const html = (path, body = '') => `<!doctype html><head>${head(path)}</head><body>${body}</body>`

/** A build that passes, to break one thing at a time. */
const good = () => ({
  'index.html': html('', '<script type="module">copy()</script>'),
  'index.md': `---\ntitle: "x"\nsource: ${PREFIX}/\n---\n`,
  '404.html': '<!doctype html><p>Not found</p>',
  'guides/getting-started/index.html': html('guides/getting-started/'),
  'guides/getting-started.md': 'x',
  'sitemap-index.xml': '<sitemapindex/>',
  'llms.txt': 'x',
  'llms-full.txt': 'x',
  'og.png': png(1200, 630),
  'version.json': JSON.stringify({ version: VERSION, commit: 'local' }),
  '_astro/site.css': 'body{color:red}',
  '_astro/page.js': 'import "./chunk.js";run()',
  '_astro/chunk.js': 'export const run = () => 1',
})

describe('pngSize', () => {
  it('reads the IHDR size and rejects anything that is not a PNG', () => {
    expect(pngSize(png(1200, 630))).toEqual({ width: 1200, height: 630 })
    expect(pngSize(Buffer.from('GIF89a…………………………………………'))).toBeNull()
  })
})

describe('prefixFrom', () => {
  it('reads the source URL without its trailing slash', () => {
    expect(prefixFrom(`---\nsource: ${PREFIX}/\n---`)).toBe(PREFIX)
    expect(prefixFrom('---\nsource: https://jev-planner.com/\n---')).toBe('https://jev-planner.com')
    expect(prefixFrom('no frontmatter')).toBeNull()
  })
})

describe('eagerAssets', () => {
  it('counts screen stylesheets and scripts, not print CSS or JSON-LD', () => {
    const found = eagerAssets(
      '<link rel="stylesheet" href="/a.css"><link rel="stylesheet" href="/p.css" media="print">' +
        '<script type="module" src="/a.js"></script><script>inline()</script>' +
        '<script type="application/ld+json">{"@type":"Thing"}</script><style>p{}</style>',
    )
    expect(found).toEqual({
      css: ['/a.css'],
      js: ['/a.js'],
      inline: ['inline()'],
      inlineCss: ['p{}'],
    })
  })
})

describe('eagerAssets, in any case', () => {
  it('finds upper-case tags and closing tags with spaces', () => {
    const found = eagerAssets(
      '<LINK REL="stylesheet" HREF="/a.css"><SCRIPT SRC="/a.js"></SCRIPT >' +
        '<Script>inline()</sCrIpT><STYLE>p{}</STYLE >',
    )
    expect(found).toEqual({
      css: ['/a.css'],
      js: ['/a.js'],
      inline: ['inline()'],
      inlineCss: ['p{}'],
    })
  })
})

describe('staticImports', () => {
  it('finds relative static imports, bare and named, and ignores packages', () => {
    const js =
      'import"./a.js";import{b as c}from"../b.js";import x from "pkg";export{d}from"./d.js"'
    expect(staticImports(js).sort()).toEqual(['../b.js', './a.js', './d.js'])
  })
})

describe('baseProblems', () => {
  it('flags a root-relative URL that skips a sub-path base', () => {
    expect(baseProblems('<a href="/guides/usage/">', BASE)).toEqual([
      'links /guides/usage/ without the base /sub/',
    ])
    expect(baseProblems('<a href="/sub/guides/usage/"><a href="//cdn.example">', BASE)).toEqual([])
  })

  it('accepts any root-relative URL at the domain root', () => {
    expect(baseProblems('<a href="/guides/usage/">', '/')).toEqual([])
  })

  it('flags the old aggregator mount at any base', () => {
    expect(baseProblems('https://rxova.org/packages/jev-planner/', '/')).toHaveLength(1)
  })
})

describe('metaProblems', () => {
  it('passes absolute URLs under the prefix', () => {
    expect(metaProblems(head(), PREFIX)).toEqual([])
  })

  it('flags missing and off-prefix canonical and og URLs', () => {
    expect(metaProblems('', PREFIX)).toEqual([
      'has no canonical link',
      'has no og:url',
      'has no og:image',
    ])
    const elsewhere = head().replaceAll(PREFIX, 'https://rxova.org/packages/jev-planner')
    expect(metaProblems(elsewhere, PREFIX)).toHaveLength(3)
  })
})

describe('checkSiteBuild', () => {
  it('passes a well-formed build and measures it', async () => {
    const { failures, sizes } = await checkSiteBuild(await dist(good()), VERSION)
    expect(failures).toEqual([])
    // Both modules are counted, the inline script only on the landing page.
    expect(sizes.allJs).toBeGreaterThan(sizes.landingJs)
    expect(sizes.landingJs).toBeGreaterThan(0)
  })

  it('reports every missing required file and stops there', async () => {
    const { failures } = await checkSiteBuild(await dist({ 'x.txt': '' }), VERSION)
    expect(failures).toEqual(REQUIRED.map((p) => `${p} is missing`))
  })

  it('fails without a source to read the prefix from', async () => {
    const { failures } = await checkSiteBuild(
      await dist({ ...good(), 'index.md': 'no source' }),
      VERSION,
    )
    expect(failures).toEqual(['index.md has no "source:" to read the site prefix from'])
  })

  it('fails a page over budget', async () => {
    // Random bytes do not compress, so the gzip size tracks the raw size.
    const bloat = Buffer.from(Array.from({ length: BUDGETS.css + 4096 }, () => Math.random() * 256))
    const { failures } = await checkSiteBuild(
      await dist({ ...good(), '_astro/site.css': bloat.toString('base64') }),
      VERSION,
    )
    expect(failures).toHaveLength(1)
    expect(failures[0]).toMatch(/^landing css is .* over the 25\.0 kB budget$/)
  })

  it('counts statically imported chunks against the JS budget', async () => {
    const bloat = Buffer.from(
      Array.from({ length: BUDGETS.allJs + 4096 }, () => Math.random() * 256),
    )
    const { failures } = await checkSiteBuild(
      await dist({ ...good(), '_astro/chunk.js': bloat.toString('base64') }),
      VERSION,
    )
    expect(failures.some((f) => f.startsWith('landing allJs'))).toBe(true)
  })

  it('allows the brand subset by name and measures it', async () => {
    const { failures, sizes } = await checkSiteBuild(
      await dist({
        ...good(),
        '_astro/space-grotesk-latin-500-normal.B7xQ-1aZ.woff2': 'x'.repeat(1000),
        '_astro/space-grotesk-latin-700-normal.Dk2f_9sE.woff2': 'x'.repeat(500),
      }),
      VERSION,
    )
    expect(failures).toEqual([])
    expect(sizes.fonts).toBe(1500)
  })

  it('fails any other weight, subset or family', async () => {
    const { failures } = await checkSiteBuild(
      await dist({
        ...good(),
        '_astro/space-grotesk-latin-600-normal.a1.woff2': 'x',
        '_astro/space-grotesk-latin-ext-500-normal.a1.woff2': 'x',
        '_astro/space-grotesk-latin-500-normal.a1.woff': 'x',
      }),
      VERSION,
    )
    expect(failures).toEqual([
      'ships font files: _astro/space-grotesk-latin-500-normal.a1.woff, ' +
        '_astro/space-grotesk-latin-600-normal.a1.woff2, ' +
        '_astro/space-grotesk-latin-ext-500-normal.a1.woff2',
    ])
  })

  it('fails fonts over budget', async () => {
    const { failures } = await checkSiteBuild(
      await dist({
        ...good(),
        '_astro/space-grotesk-latin-500-normal.a1.woff2': 'x'.repeat(BUDGETS.fonts + 1),
      }),
      VERSION,
    )
    expect(failures).toEqual(['fonts are 30.0 kB, over the 30.0 kB budget'])
  })

  it('fails a wrongly sized social card, font files and a link that skips the base', async () => {
    const { failures } = await checkSiteBuild(
      await dist({
        ...good(),
        'og.png': png(1200, 600),
        '_astro/inter.woff2': 'x',
        'guides/getting-started/index.html': html('guides/getting-started/', '<a href="/learn/">'),
      }),
      VERSION,
    )
    expect(failures).toEqual([
      'og.png is 1200×600, not 1200×630',
      'ships font files: _astro/inter.woff2',
      'guides/getting-started/index.html links /learn/ without the base /sub/',
    ])
  })

  it('fails a malformed version marker', async () => {
    for (const [body, failure] of [
      ['<html>', 'version.json is not JSON'],
      ['[]', 'version.json is not an object'],
      ['null', 'version.json is not an object'],
    ]) {
      const { failures } = await checkSiteBuild(
        await dist({ ...good(), 'version.json': body }),
        VERSION,
      )
      expect(failures).toEqual([failure])
    }
  })

  it('fails a marker for another version, with extra keys or no commit', async () => {
    const { failures } = await checkSiteBuild(
      await dist({ ...good(), 'version.json': JSON.stringify({ version: '1.2.2', built: 1 }) }),
      VERSION,
    )
    expect(failures).toEqual([
      'version.json has keys built,version',
      'version.json says 1.2.2, the package is 1.2.3',
      'version.json commit undefined is not "local" or a git sha',
    ])
  })

  it('accepts a marker from CI and rejects a commit that is not a sha', async () => {
    const marker = (commit) => ({
      ...good(),
      'version.json': JSON.stringify({ version: VERSION, commit }),
    })
    const sha = 'a'.repeat(40)
    expect((await checkSiteBuild(await dist(marker(sha)), VERSION)).failures).toEqual([])
    expect((await checkSiteBuild(await dist(marker('main')), VERSION)).failures).toEqual([
      'version.json commit main is not "local" or a git sha',
    ])
  })
})
