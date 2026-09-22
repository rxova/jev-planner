#!/usr/bin/env node
// Hold the built site to its performance budget and to its own base path.
//
// Usage: node ./scripts/check-site-build.mjs [distDir]
//
// Two failures this catches are invisible in a normal build:
//
// - Weight. A dependency bump or a new component can double what the landing
//   page ships, and the build still succeeds. The budget is enforced here so the
//   growth is a decision, not a discovery.
// - A link that skips `base`. At the domain root every root-relative URL works,
//   so a hard-coded `/guides/usage/` looks correct until the site is served from
//   a sub-path — `rxova.github.io/jev-planner/`, which is what GitHub Pages falls
//   back to without the custom domain — and then it 404s.
//
// Like check-md-routes, it reads `dist`, and it reads the site's prefix back out
// of the build rather than taking it as an argument, so it cannot be pointed at
// a different mount from the one that was built.

import { readFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

import { manifestVersion, markerProblems } from '../src/lib/version-marker.mjs'
import { collect } from './check-md-routes.mjs'

export const DEFAULT_DIST = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist')

/** Budgets in bytes. HTML, CSS and JS are gzip sizes; og.png and fonts are on disk. */
export const BUDGETS = {
  html: 30 * 1024,
  css: 25 * 1024,
  landingJs: 3 * 1024,
  // Starlight's own baseline measured 4.8 kB when this was set; 10 % over it.
  // Raise it deliberately, with the reason in the commit, never to make a build pass.
  allJs: 5.5 * 1024,
  og: 150 * 1024,
  // The two Space Grotesk files below measured 25.5 kB when this was set.
  fonts: 30 * 1024,
}

/**
 * The only font files the site may ship: Space Grotesk, the rxova brand face,
 * Latin subset, weights 500 and 700 (src/styles/fonts.css). Allowed by name so
 * that another weight, another subset or another family still fails the build
 * — a webfont is the easiest 100 kB to add without noticing.
 */
export const ALLOWED_FONTS = [
  /^_astro\/space-grotesk-latin-500-normal\.[\w-]+\.woff2$/,
  /^_astro\/space-grotesk-latin-700-normal\.[\w-]+\.woff2$/,
]

export const OG_SIZE = { width: 1200, height: 630 }

/** Files a deployable build must contain. */
export const REQUIRED = [
  'index.html',
  'index.md',
  '404.html',
  'guides/getting-started/index.html',
  'guides/getting-started.md',
  'sitemap-index.xml',
  'llms.txt',
  'llms-full.txt',
  'og.png',
  'version.json',
]

/** A docs page to compare the landing page against: what it adds is landing-specific. */
export const DOCS_PAGE = 'guides/getting-started/index.html'

/** The deploy target the site left behind. Any mention in the output is stale. */
const STALE_MOUNT = '/packages/jev-planner/'

export const gzipSize = (content) => gzipSync(content, { level: 9 }).length

/** Width and height from a PNG's IHDR chunk, or null for anything else. */
export function pngSize(buffer) {
  const signature = '89504e470d0a1a0a'
  if (buffer.length < 24 || buffer.subarray(0, 8).toString('hex') !== signature) return null
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

/** The origin-plus-base every URL on this site starts with, from the landing twin. */
export function prefixFrom(indexMd) {
  return /^source:\s*(\S+?)\/?\s*$/m.exec(indexMd.slice(0, 2048))?.[1] ?? null
}

/**
 * What a page loads before anything is clicked: its stylesheets (print ones
 * excluded), its module script files, and its inline scripts. JSON-LD is data,
 * not script, so it is not counted.
 */
export function eagerAssets(html) {
  const css = []
  for (const [tag] of html.matchAll(/<link\b[^>]*>/gi)) {
    if (!/\brel=["']?stylesheet/i.test(tag) || /\bmedia=["']?print/i.test(tag)) continue
    const href = /\bhref=["']?([^"'\s>]+)/i.exec(tag)?.[1]
    if (href) css.push(href)
  }

  const js = []
  const inline = []
  for (const [, attrs, body] of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\b[^>]*>/gi)) {
    if (/\btype=["']?application\/(?:ld\+)?json/i.test(attrs)) continue
    const src = /\bsrc=["']?([^"'\s>]+)/i.exec(attrs)?.[1]
    if (src) js.push(src)
    else if (body.trim()) inline.push(body)
  }

  // Styles inlined into the page count against the CSS budget too.
  const inlineCss = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\b[^>]*>/gi)].map(
    ([, s]) => s,
  )

  return { css, js, inline, inlineCss }
}

/** The relative modules a JS file imports statically — the ones that load with it. */
export function staticImports(js) {
  const found = new Set()
  for (const [, spec] of js.matchAll(
    /(?:^|[;\s}])import\s*(?:[\w*{}\s,$]+from\s*)?["'](\.{1,2}\/[^"']+)["']/g,
  )) {
    found.add(spec)
  }
  for (const [, spec] of js.matchAll(/\bfrom\s*["'](\.{1,2}\/[^"']+)["']/g)) found.add(spec)
  return [...found]
}

/**
 * Root-relative `href`/`src` attributes that do not start with `base`, and any
 * mention of the old aggregator mount. At `base` = `/` only the second can fail.
 */
export function baseProblems(html, base) {
  const problems = []
  if (html.includes(STALE_MOUNT)) problems.push(`mentions the old mount ${STALE_MOUNT}`)

  if (base !== '/') {
    for (const [, url] of html.matchAll(/\b(?:href|src)=["']?(\/(?!\/)[^"'\s>]*)/g)) {
      if (!url.startsWith(base)) problems.push(`links ${url} without the base ${base}`)
    }
  }
  return problems
}

/** Canonical and og:* URLs must be absolute and under the site prefix. */
export function metaProblems(html, prefix) {
  const problems = []
  const canonical = /<link\b[^>]*rel=["']?canonical[^>]*href=["']?([^"'\s>]+)/.exec(html)?.[1]
  if (!canonical) problems.push('has no canonical link')
  else if (!canonical.startsWith(`${prefix}/`)) {
    problems.push(`canonical ${canonical} is not under ${prefix}/`)
  }

  for (const property of ['og:url', 'og:image']) {
    const re = new RegExp(
      `<meta\\b[^>]*property=["']?${property}["']?[^>]*content=["']?([^"'\\s>]+)`,
    )
    const content = re.exec(html)?.[1]
    if (!content) problems.push(`has no ${property}`)
    else if (!content.startsWith(`${prefix}/`)) {
      problems.push(`${property} ${content} is not under ${prefix}/`)
    }
  }
  return problems
}

const kB = (bytes) => `${(bytes / 1024).toFixed(1)} kB`

/** `expected` is the jev-planner version the marker must name. */
export async function checkSiteBuild(distDir = DEFAULT_DIST, expected = manifestVersion()) {
  const failures = []
  const read = (path) => readFile(join(distDir, path))
  const exists = async (path) => Boolean(await stat(join(distDir, path)).catch(() => null))

  for (const path of REQUIRED) {
    if (!(await exists(path))) failures.push(`${path} is missing`)
  }
  if (failures.length > 0) return { failures, sizes: {} }

  const prefix = prefixFrom(await readFile(join(distDir, 'index.md'), 'utf8'))
  if (!prefix) return { failures: ['index.md has no "source:" to read the site prefix from'] }
  const base = new URL(`${prefix}/`).pathname

  // Asset URLs are absolute paths under the base; this maps one to a dist file.
  const fileFor = (url) => url.split(/[?#]/)[0].slice(base.length)

  // --- Budgets, on the landing page ---------------------------------------
  const landingHtml = await readFile(join(distDir, 'index.html'), 'utf8')
  const landing = eagerAssets(landingHtml)
  const docs = eagerAssets(await readFile(join(distDir, DOCS_PAGE), 'utf8'))

  const sizes = { html: gzipSize(landingHtml) }

  let css = landing.inlineCss.reduce((sum, s) => sum + gzipSize(s), 0)
  for (const href of landing.css) css += gzipSize(await read(fileFor(href)))
  sizes.css = css

  // Every eager script, and every module it statically imports, once each.
  const seen = new Set()
  const load = async (path) => {
    if (seen.has(path)) return 0
    seen.add(path)
    const content = await read(path)
    let total = gzipSize(content)
    for (const spec of staticImports(content.toString('utf8'))) {
      total += await load(join(dirname(path), spec))
    }
    return total
  }
  let allJs = landing.inline.reduce((sum, s) => sum + gzipSize(s), 0)
  for (const src of landing.js) allJs += await load(fileFor(src))
  sizes.allJs = allJs

  // What the landing page loads that a docs page does not.
  sizes.landingJs =
    landing.inline.filter((s) => !docs.inline.includes(s)).reduce((n, s) => n + gzipSize(s), 0) +
    (
      await Promise.all(
        landing.js
          .filter((s) => !docs.js.includes(s))
          .map(async (s) => gzipSize(await read(fileFor(s)))),
      )
    ).reduce((n, s) => n + s, 0)

  const og = await read('og.png')
  sizes.og = og.length

  for (const key of ['html', 'css', 'landingJs', 'allJs', 'og']) {
    if (sizes[key] > BUDGETS[key]) {
      failures.push(`landing ${key} is ${kB(sizes[key])}, over the ${kB(BUDGETS[key])} budget`)
    }
  }

  const dims = pngSize(og)
  if (!dims || dims.width !== OG_SIZE.width || dims.height !== OG_SIZE.height) {
    failures.push(
      `og.png is ${dims ? `${String(dims.width)}×${String(dims.height)}` : 'not a PNG'}, ` +
        `not ${String(OG_SIZE.width)}×${String(OG_SIZE.height)}`,
    )
  }

  const fonts = (await collect(distDir, '')).filter((f) => /\.(?:woff2?|ttf|otf)$/.test(f))
  const unknown = fonts.filter((f) => !ALLOWED_FONTS.some((allowed) => allowed.test(f)))
  if (unknown.length > 0) failures.push(`ships font files: ${unknown.slice(0, 3).join(', ')}`)
  sizes.fonts = 0
  for (const f of fonts) sizes.fonts += (await read(f)).length
  if (sizes.fonts > BUDGETS.fonts) {
    failures.push(`fonts are ${kB(sizes.fonts)}, over the ${kB(BUDGETS.fonts)} budget`)
  }

  failures.push(...markerProblems(await readFile(join(distDir, 'version.json'), 'utf8'), expected))

  // --- Base-path safety, on every page -----------------------------------
  for (const html of await collect(distDir, '.html')) {
    const content = await readFile(join(distDir, html), 'utf8')
    for (const problem of baseProblems(content, base)) failures.push(`${html} ${problem}`)
    if (html !== '404.html') {
      for (const problem of metaProblems(content, prefix)) failures.push(`${html} ${problem}`)
    }
  }

  return { failures, sizes }
}

// Only run as a CLI; the tests import the functions above.
if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const [, , dist = DEFAULT_DIST] = process.argv
  const { failures, sizes } = await checkSiteBuild(dist)

  if (failures.length > 0) {
    console.error(
      [
        `${String(failures.length)} site-build problem(s):`,
        ...failures.map((f) => `  ✗ ${f}`),
      ].join('\n'),
    )
    process.exit(1)
  }
  const report = Object.entries(sizes).map(([k, v]) => `${k} ${kB(v)}`)
  console.log(`✔ within budget (${report.join(', ')}), every URL under the base`)
}
