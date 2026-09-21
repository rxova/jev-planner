// Resolve doc-relative `.md` links in the rendered HTML.
//
// The content is written with links like `../guides/serialization.md`, because
// that is the shape the `.md` twins need (see src/lib/mdx-to-markdown.mjs) and
// because it is the shape that stays correct when a page is read as a file. What
// it is not is a URL this site serves: the HTML page for that source file lives
// at `/guides/serialization/`.
//
// Astro does not rewrite these. It emits the href verbatim, which produces a
// page full of links that 404 — and `starlight-links-validator` does not catch
// it either, because a relative link is not something it resolves. So the build
// would ship dead links and nothing in it would object, which is why this runs
// as part of the pipeline rather than as a lint anyone has to remember.
//
// The mapping is the same one `mdRoute` implements from the other side: a page's
// source path *is* its route. Strip the extension, keep the fragment, add the
// mount base.

import { relative, dirname, sep } from 'node:path'

import { withBase } from './base-url.mjs'
import { normalizePath } from './mdx-to-markdown.mjs'

const posix = (p) => p.split(sep).join('/')

/** `/guides/serialization.md` -> `/guides/serialization/`, and `/index.md` -> `/`. */
function routeFor(path) {
  const id = path.replace(/\.md$/, '')
  return id === '/index' ? '/' : `${id}/`
}

/** Every element in the tree, depth first. `unist-util-visit` for one node type. */
function walk(node, fn) {
  if (node.type === 'element') fn(node)
  for (const child of node.children ?? []) walk(child, fn)
}

/**
 * @param {{ base: string, docsRoot: string }} options
 *   `docsRoot` is the content directory every source path is relative to, since
 *   the route is the path below it.
 */
export function rehypeMdLinks({ base, docsRoot }) {
  return (tree, file) => {
    // A page rendered from something other than a file on disk has no source
    // path to resolve against. Nothing here is worth a crash.
    if (!file?.path) return

    const from = `/${posix(relative(docsRoot, file.path))}`
    const dir = dirname(from)

    walk(tree, (node) => {
      if (node.tagName !== 'a') return

      const href = node.properties?.href
      if (typeof href !== 'string') return

      const match = /^(\.{1,2}\/[^#]*\.md|[^/#:][^#:]*\.md)(#.*)?$/.exec(href)
      if (!match) return

      const [, path, hash = ''] = match
      node.properties.href = withBase(routeFor(normalizePath(`${dir}/${path}`)), base) + hash
    })
  }
}
