// Pure helpers describing the shape of the docs as a set of pages.
//
// Kept apart from docs-md.mjs, which imports `astro:content` and so only exists
// inside an Astro build. Everything here is ordinary JavaScript over plain
// objects, which is what makes it testable — and these are exactly the rules
// worth testing, because a wrong route or a mis-sectioned page produces output
// that still looks complete.

import { splitFenced } from './mdx-to-markdown.mjs'

/**
 * One documentation page, normalized.
 *
 * Declared here rather than left to inference because `docs-md.mjs` builds these
 * out of `astro:content`, whose types only exist once Astro has generated
 * `.astro/types.d.ts` — so on a clean checkout the whole shape collapses to
 * `any` and every consumer of it silently loses its types. This typedef is the
 * contract the `.md` twins, `llms.txt` and `llms-full.txt` all read.
 *
 * @typedef {object} DocsPage
 * @property {string} id Content-layer id; `index` for the home page.
 * @property {string} title Frontmatter title.
 * @property {string | undefined} description Frontmatter description, or the first sentence.
 * @property {string} section Top-level directory, or `root`.
 * @property {string} mdRoute The `.md` route, relative to this build's base.
 * @property {string} htmlUrl Absolute URL of the canonical HTML page.
 * @property {string} mdUrl Absolute URL of the `.md` twin.
 * @property {string} body The page body as plain markdown.
 */

/**
 * The home page's id.
 *
 * Astro's content layer names `index.md` after its path, so the id is the
 * literal string `index`, not the empty string. The distinction is invisible
 * until you use it: with `''` assumed, `htmlRoute` falls through to `/index/`,
 * which is not a route this site serves, and every twin would cite a dead URL
 * as its source.
 */
export const HOME = 'index'

/** The `.md` route for a page id. The home page is `/index.md`, not `/.md`. */
export const mdRoute = (id) => `/${id || HOME}.md`

/** The canonical HTML route, which the `.md` twin cites as its source. */
export const htmlRoute = (id) => (!id || id === HOME ? '/' : `/${id}/`)

/**
 * Which part of the site a page belongs to, as llms.txt sections.
 *
 * Derived from the content tree rather than declared anywhere: these docs are
 * organised by top-level directory, and that directory is the sidebar group, so
 * a new page under `guides/` sections itself and a whole new directory gets its
 * own heading with no edit here. `src/lib/llms.mjs` maps the directory name to a
 * human label; a directory it does not know still appears, under its own name.
 */
export function sectionOf(id) {
  if (id === HOME) return 'root'
  // A file at the content root is framing material, not a section of its own —
  // there is no directory to name it after.
  return id.includes('/') ? id.split('/')[0] : 'root'
}

/**
 * First sentence of the body, for a page whose frontmatter carries no
 * description.
 *
 * A bare list of thirty links tells a reader nothing about which one answers
 * their question. Every page here does set a description, so this is the
 * fallback that keeps a page which forgot from contributing nothing.
 */
export const MAX_DESCRIPTION = 200

export function firstSentence(body) {
  // Fence CONTENTS, not just the fence markers. Filtering line-by-line on a
  // leading ``` drops the delimiters and keeps the code between them, so a page
  // that opens with a diff would be described as "- statements: 95,".
  const prose = splitFenced(body)
    .unfenced.split('\n')
    // Fences, headings, JSX, and directive syntax: none of them summarise a page.
    .filter(
      (line) => line.trim() && !/^\s*(?:[`~]{3}|#|<|import\b|export\b|:::|\||-{3,})/.test(line),
    )
    .join(' ')
    // Links collapse to their text. Stripping only the brackets would leave the
    // URL welded to the words around it.
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    // Emphasis comes off BEFORE the match, not after. A page opening
    // "**defineError** returns a class." would otherwise have its sentence-ending
    // period followed by `*` rather than whitespace, so nothing would match and
    // the page would silently lose its description.
    .replace(/[*_`[\]]/g, '')
    .trim()

  const match = new RegExp(`^(.{20,${MAX_DESCRIPTION}}?[.!?])\\s`).exec(`${prose} `)
  if (match) return match[1]

  // No sentence ends inside the budget. Truncating beats returning nothing: a
  // page arriving in llms.txt as a bare link with no idea what it covers is the
  // one thing the index exists to prevent.
  if (prose.length <= 20) return undefined
  const clipped = prose.slice(0, MAX_DESCRIPTION)
  const lastSpace = clipped.lastIndexOf(' ')
  return `${(lastSpace > 20 ? clipped.slice(0, lastSpace) : clipped).replace(/[,;:—-]$/, '')}…`
}

/**
 * The document served at a `.md` route.
 *
 * The synthesized frontmatter is not decoration. Starlight pages carry their
 * title in frontmatter and no H1 in the body, so passing the body through would
 * arrive untitled; `source` is what lets a reader cite the human page it came
 * from.
 *
 * @param {DocsPage} page
 * @returns {string}
 */
export function renderMarkdown(page) {
  return [
    '---',
    `title: ${JSON.stringify(page.title)}`,
    ...(page.description ? [`description: ${JSON.stringify(page.description)}`] : []),
    `source: ${page.htmlUrl}`,
    '---',
    '',
    `# ${page.title}`,
    '',
    page.body,
    '',
  ].join('\n')
}
