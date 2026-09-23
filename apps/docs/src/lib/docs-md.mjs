// One enumeration of the docs, shared by every agent-facing endpoint.
//
// The `.md` twins, llms.txt and llms-full.txt all describe the same set of
// pages. If each built its own list they would disagree — a page in one and not
// the other — and the disagreement would be invisible, because each output still
// looks complete on its own. So they all call `docsPages()`.
//
// This module imports `astro:content`, so it only resolves inside an Astro
// build. The rules worth testing live in docs-pages.mjs and mdx-to-markdown.mjs,
// which are plain modules; this file is the adapter between them and the
// collection.

import { getCollection } from 'astro:content'

import { withBase } from './base-url.mjs'
import { mdxToMarkdown } from './mdx-to-markdown.mjs'
import {
  HOME,
  byReadingOrder,
  sectionOf,
  mdRoute,
  htmlRoute,
  firstSentence,
} from './docs-pages.mjs'

/**
 * A splash page is a landing page, not a document.
 *
 * No page here is one today — `index.md` is ordinary prose and belongs in the
 * twins. The rule is keyed off frontmatter rather than an id list so that if a
 * splash is ever added it excludes itself, instead of being served to an agent
 * as a hollowed-out `.md` that costs a fetch and teaches it nothing.
 */
const isSplash = (entry) => entry.data.template === 'splash'

/**
 * Every documentation page, normalized to markdown, in reading order.
 *
 * `origin` and `base` come from the caller's `import.meta.env`, so a preview
 * build links to itself rather than advertising production URLs.
 *
 * The return type is written out rather than inferred: `getCollection` is typed
 * by the declarations Astro generates into `.astro/`, which are gitignored and
 * absent until something has built, so inference gives `any` on a clean
 * checkout and every caller loses its types with it.
 *
 * @param {{ origin: string, base?: string }} options
 * @returns {Promise<import('./docs-pages.mjs').DocsPage[]>}
 */
export async function docsPages({ origin, base = '/' }) {
  const toUrl = (pathname) => `${origin}${withBase(pathname, base)}`
  const entries = await getCollection('docs', (entry) => !isSplash(entry))

  return entries
    .map((entry) => {
      const body = entry.body ?? ''
      const id = entry.id || HOME
      // Doc-relative links resolve against the twin being written, so the route
      // has to be computed before the body is normalized rather than alongside it.
      const route = mdRoute(entry.id)

      return {
        id,
        title: entry.data.title,
        description: entry.data.description ?? firstSentence(body),
        section: sectionOf(id),
        // Starlight defaults `sidebar` to an object, so this is a read, not a
        // guess; a page without an order sorts last, as it does in the sidebar.
        order: entry.data.sidebar?.order,
        // The route is relative to this build's base, because that is what Astro
        // writes to disk. The URLs are absolute, because a `.md` read detached
        // from the site has nothing to resolve a relative link against.
        mdRoute: route,
        htmlUrl: toUrl(htmlRoute(entry.id)),
        mdUrl: toUrl(route),
        body: mdxToMarkdown(body, { origin, base, fromRoute: route }),
      }
    })
    .sort(byReadingOrder)
}
