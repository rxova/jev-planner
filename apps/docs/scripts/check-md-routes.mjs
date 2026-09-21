#!/usr/bin/env node
// Verify the raw-markdown twins in a built site.
//
// Usage: node ./scripts/check-md-routes.mjs [distDir]
//
// The `.md` routes exist so an agent can read these docs without parsing a
// Starlight page. Their failure mode is the reason this script exists: if a page
// starts using a construct src/lib/mdx-to-markdown.mjs does not handle, the
// build still succeeds and the `.md` still reads as a document — it just has
// `<TabItem label="npm">` sitting in the middle of it, or a link that resolves
// nowhere. Nothing else in the build would notice, and the reader who would is a
// model with no way to ask.
//
// So this asserts the things rendering cannot check: that every page has a twin,
// that no twin still contains unhandled markup, and that every link from one
// twin to another lands on a twin that exists.
//
// It reads `dist`, never `src/content`, because dist is what ships.

import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative, sep, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { splitFenced } from '../src/lib/mdx-to-markdown.mjs'

export const DEFAULT_DIST = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist')

/**
 * Pages that are deliberately not twinned.
 *
 * Only Astro's 404. The landing page is a splash, but it has a hand-written twin
 * (src/pages/index.md.ts) rendered from the same copy, so it is checked like any
 * other page. Nothing else is excluded, and a page that arrives without a twin is
 * a bug rather than a category.
 */
export const isUntwinned = (htmlPath) => htmlPath === '404.html'

/**
 * Markup that must not survive into a `.md`, each with what it means when it does.
 *
 * Checked against the unfenced text only. These docs are largely TypeScript
 * snippets and serialized JSON, and a fence may legitimately contain any of
 * these — a payload with a `"stack"` full of paths, or a snippet importing from
 * a scoped package. Scanning the whole document flags those, and the obvious
 * "fix" is to rewrite the contents of fences, which corrupts the examples.
 */
export const FORBIDDEN = [
  [/<(?:Tabs|TabItem|CardGrid|Card)\b/, 'an unhandled Starlight/MDX component'],
  [
    /^import\s.+\sfrom\s'@(?:astrojs|components)\//m,
    'an MDX import that should have been stripped',
  ],
  [/\]\(\/(?!\/)/, 'a root-relative link, unresolvable outside the site'],
  [/\]\(\.{1,2}\//, 'a doc-relative link that resolveRelativeLinks did not resolve'],
  [/\b(?:href|src)="\/(?!\/)/, 'a root-relative HTML attribute'],
  [/\bimport\.meta\.env\.BASE_URL/, 'an unresolved BASE_URL expression'],
]

/**
 * llms-full.txt inlines every page, so it grows with the docs. Past roughly this
 * size it stops fitting comfortably in a context window and quietly becomes the
 * thing it exists to avoid. Fail instead, so splitting it is a decision somebody
 * makes rather than something an agent discovers by being handed half a file.
 */
export const MAX_LLMS_FULL_BYTES = 800 * 1024

/**
 * llms.txt is an index, and an index that is expensive to fetch has stopped
 * being one.
 */
export const MAX_LLMS_INDEX_BYTES = 24 * 1024

const posix = (p) => p.split(sep).join('/')

/** Every file under `dir` matching `ext`, as paths relative to `dir`. */
export async function collect(dir, ext, root = dir) {
  const found = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...(await collect(path, ext, root)))
    else if (entry.isFile() && entry.name.endsWith(ext)) found.push(posix(relative(root, path)))
  }
  return found
}

/** The `.md` twin a built page should have: `a/b/index.html` -> `a/b.md`. */
export function twinFor(htmlPath) {
  return htmlPath === 'index.html' ? 'index.md' : `${htmlPath.replace(/\/index\.html$/, '')}.md`
}

/**
 * A page that is a redirect stub has no content to twin. Astro writes one for
 * every entry in the config's `redirects` map. There are none today; the rule
 * costs nothing and the first redirect will not have to come back here first.
 */
const isRedirect = (html) => /<meta[^>]+http-equiv=["']?refresh/i.test(html)

/**
 * The absolute prefix this build's URLs carry — origin plus base.
 *
 * Read back out of the output rather than passed in, so the checker cannot be
 * run against a different mount than the one that was built. Every twin states
 * its own canonical page in `source:`, and the twin's path on disk says what the
 * tail of that URL must be, so the two together give the prefix exactly.
 *
 * `index.md` is skipped: its route is `/`, which is a suffix of every URL and so
 * pins nothing down.
 */
export async function sitePrefix(distDir, mdFiles) {
  for (const md of [...mdFiles].sort()) {
    if (md === 'index.md') continue
    const head = (await readFile(join(distDir, md), 'utf8')).slice(0, 2048)
    const source = /^source:\s*(\S+)\s*$/m.exec(head)?.[1]
    if (!source) continue

    const tail = `${md.replace(/\.md$/, '')}/`
    if (source.endsWith(tail)) return source.slice(0, -tail.length)
  }
  return null
}

export async function checkMdRoutes(distDir = DEFAULT_DIST) {
  const failures = []

  const htmlFiles = await collect(distDir, '.html')
  const mdFiles = new Set(await collect(distDir, '.md'))

  for (const html of htmlFiles) {
    if (isUntwinned(html)) continue
    if (isRedirect(await readFile(join(distDir, html), 'utf8'))) continue

    const twin = twinFor(html)
    if (!mdFiles.has(twin)) failures.push(`${html} has no markdown twin at ${twin}`)
  }

  const prefix = await sitePrefix(distDir, mdFiles)
  if (mdFiles.size > 0 && !prefix) {
    failures.push('could not determine the site prefix from any twin\'s "source:" frontmatter')
  }

  for (const md of [...mdFiles].sort()) {
    const { unfenced } = splitFenced(await readFile(join(distDir, md), 'utf8'))

    const report = (match, why) => {
      if (match) failures.push(`${md} contains ${why}: ${JSON.stringify(match[0].slice(0, 60))}`)
    }

    for (const [pattern, why] of FORBIDDEN) report(pattern.exec(unfenced), why)

    // Every in-site `.md` link must land on a twin that exists. This is the rule
    // that catches a page linking to `./why.md` when the page is at
    // `learn/why` — a well-formed link that nothing else in the build reads.
    if (!prefix) continue
    const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    for (const [, target] of unfenced.matchAll(
      new RegExp(`\\]\\(${escaped}([^)\\s#]*\\.md)`, 'g'),
    )) {
      if (!mdFiles.has(target)) failures.push(`${md} links to ${target}, which is not a twin`)
    }
  }

  // Only checked when they exist, so this script stays usable against a build
  // that predates the llms.txt endpoints.
  const budgets = [
    ['llms-full.txt', MAX_LLMS_FULL_BYTES, 'split it or raise the budget deliberately'],
    [
      'llms.txt',
      MAX_LLMS_INDEX_BYTES,
      'it is an index — collapse a section rather than raising this',
    ],
  ]

  for (const [name, budget, advice] of budgets) {
    const found = await stat(join(distDir, name)).catch(() => null)
    if (found && found.size > budget) {
      failures.push(
        `${name} is ${Math.round(found.size / 1024)} kB, over the ` +
          `${budget / 1024} kB budget — ${advice}`,
      )
    }
  }

  return { failures, pages: htmlFiles.length, twins: mdFiles.size }
}

export function formatFailures(failures) {
  return [`${failures.length} markdown-route problem(s):`, ...failures.map((f) => `  ✗ ${f}`)].join(
    '\n',
  )
}

// Only run as a CLI; the tests import the functions above.
if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const [, , dist = DEFAULT_DIST] = process.argv
  const { failures, twins } = await checkMdRoutes(dist)

  if (failures.length > 0) {
    console.error(formatFailures(failures))
    process.exit(1)
  }
  console.log(`✔ ${twins} markdown twin(s), no unhandled markup, no dangling links`)
}
