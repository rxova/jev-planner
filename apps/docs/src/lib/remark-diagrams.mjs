// Draw the diagrams from hand-written SVGs, keyed by the Mermaid fence that describes them.
//
// A page writes a diagram as a Mermaid fence with a `diagram=<id>` info string:
//
//     ```mermaid diagram=pipeline
//     flowchart TD
//       task["Task and repository"] --> drafts["Every agent drafts"]
//     ```
//
// The `.md` twin is built from the source (see src/lib/mdx-to-markdown.mjs), so
// an agent reading it gets the Mermaid text. The HTML page gets the SVG from
// src/diagrams/<id>.svg, inlined here, in a <figure>. Several ids, comma-separated,
// go side by side in one figure. The caption is `caption="…"` from the info
// string, or else the one SVG's <title>.
//
// ## Why not Mermaid itself
//
// Mermaid in the browser costs far more script than the site's JS budget
// allows, and Mermaid at build time needs a headless browser inside
// `astro build`. An SVG loaded through <img> sees only `prefers-color-scheme`,
// not Starlight's theme toggle, so its colours fail in one theme. An inline
// SVG takes its colours from theme.css like the rest of the page.
//
// ## Keeping the two in step
//
// Every double-quoted string in the Mermaid is a label, and each one has to
// appear in the SVG's text, or the build fails. That catches a renamed or added
// step. It does not catch a redrawn arrow, so check those in review against
// planner-core's orchestrator, round, debate-review and synthesis modules.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ID = /(?:^|\s)diagram=([\w,-]+)(?:\s|$)/

const clean = (text) => text.replace(/\s+/g, ' ').trim()

const decode = (text) =>
  text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, '&')

/** The labels a Mermaid source names: its double-quoted strings, comments aside. */
export function mermaidLabels(source) {
  const labels = []
  for (const line of source.split('\n')) {
    if (line.trim().startsWith('%%')) continue
    for (const [, label] of line.matchAll(/"([^"]*)"/g)) {
      const text = clean(label.replace(/<br\s*\/?>/gi, ' '))
      if (text) labels.push(text)
    }
  }
  return labels
}

/** The words an SVG draws: every <text>, its <tspan> lines joined by spaces. */
export function svgText(svg) {
  return [...svg.matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/g)]
    .map(([, body]) => clean(decode(body.replace(/<[^>]+>/g, ' '))))
    .join(' ')
}

const title = (svg) => /<title\b[^>]*>([\s\S]*?)<\/title>/.exec(svg)?.[1]

/** Every node in the tree, with its parent, depth first. */
function walk(node, fn, parent) {
  fn(node, parent)
  for (const child of node.children ?? []) walk(child, fn, node)
}

/**
 * @param {{ dir: string }} options
 *   `dir` holds one `<id>.svg` per diagram.
 */
export function remarkDiagrams({ dir }) {
  const read = (id) => {
    try {
      return readFileSync(join(dir, `${id}.svg`), 'utf8').trim()
    } catch {
      throw new Error(`No diagram "${id}": expected ${join(dir, `${id}.svg`)}`)
    }
  }

  return (tree, file) => {
    const where = file?.path ?? 'a page'

    walk(tree, (node, parent) => {
      if (node.type !== 'code' || node.lang !== 'mermaid') return

      // Mermaid does not run on this site, so a fence with no drawing would
      // ship as a code block nobody meant to show.
      const ids = ID.exec(node.meta ?? '')?.[1]
        ?.split(',')
        .filter(Boolean)
      if (!ids?.length) {
        throw new Error(`${where}: a mermaid fence needs diagram=<id> and src/diagrams/<id>.svg`)
      }

      const svgs = ids.map(read)
      for (const [i, svg] of svgs.entries()) {
        if (!/^<svg\b[^>]*\brole="img"/.test(svg) || !title(svg) || !/<desc\b/.test(svg)) {
          throw new Error(`${ids[i]}.svg: needs role="img", a <title> and a <desc>`)
        }
        if (/<style\b/.test(svg)) {
          throw new Error(`${ids[i]}.svg: colour it from theme.css, not a <style> element`)
        }
      }

      const drawn = svgs.map(svgText).join(' ')
      const missing = mermaidLabels(node.value).filter((label) => !drawn.includes(label))
      if (missing.length > 0) {
        throw new Error(
          `${where}: diagram ${ids.join(',')} does not draw ${missing.map((l) => `"${l}"`).join(', ')}`,
        )
      }

      // A caption in the info string wins; one drawing falls back to its <title>.
      const caption =
        /caption="([^"]+)"/.exec(node.meta)?.[1] ?? (svgs.length === 1 ? title(svgs[0]) : undefined)
      if (!caption) throw new Error(`${where}: diagrams side by side need caption="…"`)

      const body = svgs.length === 1 ? svgs[0] : `<div class="diagram-row">${svgs.join('')}</div>`
      parent.children[parent.children.indexOf(node)] = {
        type: 'html',
        value: `<figure class="diagram">${body}<figcaption>${caption}</figcaption></figure>`,
      }
    })
  }
}
