// Turn a docs page's markdown source into the plain markdown served at its `.md`
// twin (see src/pages/[...slug].md.ts).
//
// ## Why normalize the source rather than render and convert back
//
// Rendering to HTML and converting back would need another dependency, and it
// would reformat every code fence on the way through — and the fences are the
// one thing a reader of these pages wants verbatim, because half of them are
// diffs. The body already is markdown for almost all of its bytes. What is left
// is a closed set of constructs, listed in the rules below, and
// `scripts/check-md-routes.mjs` fails the build if a page grows one this file
// does not handle, so the set cannot quietly drift.
//
// ## The rule that matters
//
// Every `import` line in this content sits inside a code fence — they are the
// snippets the docs are made of. So no rule may be applied blindly across a
// document: everything runs through `mapUnfenced`, and a fence's contents are
// never touched. Getting this wrong guts the examples silently, which is exactly
// the failure a model would not notice and would then repeat back at you.

import { withBase } from './base-url.mjs'

/** Opening or closing fence: ``` or ~~~, three or more, optionally indented. */
const FENCE = /^(\s*)(`{3,}|~{3,})(.*)$/

/**
 * Split into fenced and unfenced runs and apply `fn` to the unfenced ones only.
 *
 * `onFenceOpen` sees each opening fence line, so a caller can inspect the info
 * string, which is not fence content.
 */
export function mapUnfenced(text, fn, onFenceOpen = (line) => line) {
  const out = []
  let buffer = []
  let marker = null

  const flush = () => {
    if (buffer.length > 0) out.push(fn(buffer.join('\n')))
    buffer = []
  }

  for (const line of text.split('\n')) {
    const match = FENCE.exec(line)

    if (marker === null) {
      if (match) {
        flush()
        marker = match[2]
        out.push(onFenceOpen(line))
      } else {
        buffer.push(line)
      }
      continue
    }

    out.push(line)
    // A closing fence is the same character, at least as long, and carries no
    // info string. Anything else is content that merely looks like a fence.
    if (
      match &&
      match[2][0] === marker[0] &&
      match[2].length >= marker.length &&
      !match[3].trim()
    ) {
      marker = null
    }
  }

  flush()
  return out.join('\n')
}

/**
 * The document split into what a rule may look at.
 *
 * `scripts/check-md-routes.mjs` needs the same fence-awareness this module has:
 * scanning a whole `.md` for a doc-relative link flags every snippet that
 * legitimately contains one. Sharing the split means the checker and the
 * normalizer can never disagree about where a fence begins.
 */
export function splitFenced(text) {
  const unfenced = []
  const openers = []
  mapUnfenced(
    text,
    (chunk) => {
      unfenced.push(chunk)
      return chunk
    },
    (line) => {
      openers.push(line)
      return line
    },
  )
  return { unfenced: unfenced.join('\n'), openers }
}

/** Real MDX imports. Only ever called on unfenced text — see the header. */
export function stripImports(text) {
  return text.replace(/^import[ \t][^\n]*\n?/gm, '')
}

/**
 * Starlight's layout components, which carry no information a reader loses.
 *
 * This content uses none of them today. The rules stay because the alternative
 * is worse: `check-md-routes.mjs` fails the build the moment a page grows one,
 * and a contributor who adds a `<Tabs>` block should get a working twin rather
 * than a build error telling them to come here first.
 *
 * `<TabItem label="npm">` and `<Card title="…">` do carry a label, so they
 * become headings rather than vanishing — otherwise the install snippets in a
 * Tabs block arrive as unlabelled fences and the reader cannot tell npm from
 * pnpm, which is the one thing that block exists to say.
 */
export function unwrapStarlightComponents(text) {
  return text
    .replace(/^[ \t]*<TabItem\b[^>]*\blabel="([^"]*)"[^>]*>[ \t]*$/gm, '#### $1\n')
    .replace(/^[ \t]*<Card\b[^>]*\btitle="([^"]*)"[^>]*>[ \t]*$/gm, '### $1\n')
    .replace(/^[ \t]*<\/?(?:Tabs|TabItem|CardGrid|Card)\b[^>]*>[ \t]*$/gm, '')
}

/**
 * Collapse `.` and `..` in a rooted path. `/learn/../rules/x.md` -> `/rules/x.md`.
 *
 * `..` past the root is clamped rather than allowed to escape, matching how a
 * browser resolves an over-deep relative URL. A link that needed the clamp is
 * wrong at the source, and `check-md-routes.mjs` reports it as a dangling twin
 * rather than letting it quietly resolve to something plausible.
 */
export function normalizePath(path) {
  const out = []
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') out.pop()
    else out.push(segment)
  }
  return `/${out.join('/')}`
}

/**
 * Doc-relative links into absolute twin URLs.
 *
 * `../guides/serialization.md` written in `learn/why.md` means the source
 * file `guides/serialization.md`, and that file's twin is served at
 * `/guides/serialization.md` — the twin route *is* the source path, because
 * `mdRoute` is the page id plus `.md`. So resolving the link as a path from the
 * docs root lands on exactly the right document, and the fragment rides along
 * untouched.
 *
 * `fromRoute` is the twin's own route, so resolution happens relative to the
 * document being written rather than to wherever it is later pasted.
 *
 * Lowercased, because Astro's content layer lowercases a file path when it
 * derives the entry id, and the id is what the route is built from. Every
 * filename here is already lower-case, so today this only matters if one is not.
 */
export function resolveRelativeLinks(text, { origin, base, fromRoute }) {
  const dir = fromRoute.slice(0, fromRoute.lastIndexOf('/') + 1)

  return text.replace(
    /(\]\()(\.{1,2}\/[^)\s#]*\.md)(#[^)\s]*)?(\))/g,
    (_, open, path, hash = '', close) =>
      open + origin + withBase(normalizePath(dir + path).toLowerCase(), base) + hash + close,
  )
}

/**
 * Site-root URLs into absolute ones.
 *
 * A `.md` twin gets read detached from the site — pasted into a prompt, fetched
 * on its own — so a root-relative link is not merely inconvenient, it is
 * unresolvable. Composes `withBase` rather than concatenating, so the
 * site's base is applied by the same idempotent function every
 * other link on the site uses.
 */
export function absolutizeUrls(text, { origin, base }) {
  const url = (pathname) => `${origin}${withBase(pathname, base)}`

  return (
    text
      // Markdown links and images: [x](/path), ![x](/path)
      .replace(/(\]\()(\/(?!\/)[^)\s]*)/g, (_, open, path) => open + url(path))
      // Raw HTML attributes. None in this content today; cheap insurance.
      .replace(/\b(href|src)="(\/(?!\/)[^"]*)"/g, (_, attr, path) => `${attr}="${url(path)}"`)
      // JSX expression attributes built on Astro's BASE_URL, which is how a page
      // would reference an asset without hardcoding the mount. BASE_URL has a
      // trailing slash, so what follows it is relative.
      .replace(
        /\b(href|src)=\{`\$\{import\.meta\.env\.BASE_URL\}([^`]*)`\}/g,
        (_, attr, rest) => `${attr}="${url(`/${rest}`)}"`,
      )
  )
}

/**
 * The whole pipeline. `origin` and `base` come from Astro (`import.meta.env.SITE`
 * and `BASE_URL`), so a production build and a sub-path build each
 * emit links to themselves.
 *
 * Relative links are resolved before root-relative ones. Order matters:
 * resolution turns `../rules/x.md` into a rooted path, and running
 * `absolutizeUrls` first would leave it the only unhandled link shape in the
 * document.
 */
export function mdxToMarkdown(source, { origin, base = '/', fromRoute = '/index.md' }) {
  return (
    mapUnfenced(source, (chunk) =>
      absolutizeUrls(
        resolveRelativeLinks(unwrapStarlightComponents(stripImports(chunk)), {
          origin,
          base,
          fromRoute,
        }),
        { origin, base },
      ),
    )
      // Unwrapping components and stripping imports both leave blank lines behind.
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  )
}
