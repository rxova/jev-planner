import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { mermaidLabels, remarkDiagrams, svgText } from './remark-diagrams.mjs'

const svg = (text, { title = 'A flow', extra = '' } = {}) =>
  `<svg role="img" viewBox="0 0 10 10"><title>${title}</title><desc>d</desc>${extra}` +
  `<text>${text}</text></svg>`

/** A diagrams folder holding `files`, as id → SVG source. */
function folder(files) {
  const dir = mkdtempSync(join(tmpdir(), 'diagrams-'))
  for (const [id, source] of Object.entries(files)) writeFileSync(join(dir, `${id}.svg`), source)
  return dir
}

const fence = (value, meta) => ({ type: 'code', lang: 'mermaid', meta, value })

/** Run the plugin over a one-fence page and hand back what replaced the fence. */
function render(node, files) {
  const tree = { type: 'root', children: [node] }
  remarkDiagrams({ dir: folder(files) })(tree, { path: 'page.md' })
  return tree.children[0]
}

describe('mermaidLabels', () => {
  it('reads every double-quoted string, with <br> as a space and comments skipped', () => {
    const source = [
      'flowchart TD',
      '  %% "not a label"',
      '  a["Every agent<br>drafts"] -->|"another pass"| b["Merge"]',
    ].join('\n')

    expect(mermaidLabels(source)).toEqual(['Every agent drafts', 'another pass', 'Merge'])
  })
})

describe('svgText', () => {
  it('joins every <text>, its <tspan> lines included, and decodes entities', () => {
    const source = '<text>Plan &amp; <tspan>merge</tspan></text><text>&lt;b&gt; &#8805;</text>'

    expect(svgText(source)).toBe('Plan & merge <b> ≥')
  })
})

describe('remarkDiagrams', () => {
  it('replaces the fence with a figure holding the SVG, captioned with its title', () => {
    const node = render(fence('a["Merge"]', 'diagram=flow'), { flow: svg('Merge') })

    expect(node.type).toBe('html')
    expect(node.value).toBe(
      `<figure class="diagram">${svg('Merge')}<figcaption>A flow</figcaption></figure>`,
    )
  })

  it('puts several drawings side by side, under the caption the fence gives', () => {
    const node = render(fence('a["One"] --> b["Two"]', 'diagram=one,two caption="Both"'), {
      one: svg('One'),
      two: svg('Two'),
    })

    expect(node.value).toBe(
      `<figure class="diagram"><div class="diagram-row">${svg('One')}${svg('Two')}</div>` +
        '<figcaption>Both</figcaption></figure>',
    )
  })

  it('needs a caption for drawings side by side', () => {
    expect(() => render(fence('', 'diagram=one,two'), { one: svg(''), two: svg('') })).toThrow(
      /caption=/,
    )
  })

  it('fails the build on an id with no SVG', () => {
    expect(() => render(fence('', 'diagram=missing'), {})).toThrow(/No diagram "missing"/)
  })

  it('fails the build on a mermaid fence with no diagram id, which would ship as code', () => {
    expect(() => render(fence('a["Merge"]', null), {})).toThrow(/needs diagram=<id>/)
  })

  it('fails the build when the SVG does not draw a label the Mermaid names', () => {
    expect(() =>
      render(fence('a["Merge"] --> b["Adopt"]', 'diagram=flow'), { flow: svg('Merge') }),
    ).toThrow(/does not draw "Adopt"/)
  })

  it.each([
    ['no role', svg('').replace(' role="img"', '')],
    ['no title', svg('').replace('<title>A flow</title>', '')],
    ['no desc', svg('').replace('<desc>d</desc>', '')],
  ])('rejects an SVG with %s, which a screen reader could not name', (_, source) => {
    expect(() => render(fence('', 'diagram=flow'), { flow: source })).toThrow(/role="img"/)
  })

  it('rejects a <style> element, which would bypass the theme', () => {
    const source = svg('', { extra: '<style>text{fill:red}</style>' })

    expect(() => render(fence('', 'diagram=flow'), { flow: source })).toThrow(/theme\.css/)
  })

  it('leaves every other code block alone', () => {
    const node = { type: 'code', lang: 'sh', meta: null, value: 'pnpm build' }

    expect(render(node, {})).toBe(node)
  })
})

describe('the diagrams on this site', () => {
  const docs = fileURLToPath(new URL('../content/docs', import.meta.url))
  const dir = fileURLToPath(new URL('../diagrams', import.meta.url))
  const pages = readdirSync(docs, { recursive: true }).filter((p) => p.endsWith('.md'))
  const fences = pages.flatMap((page) =>
    [...readFileSync(join(docs, page), 'utf8').matchAll(/^```mermaid (.*)\n([\s\S]*?)^```$/gm)].map(
      ([, meta, value]) => ({ page, meta, value }),
    ),
  )

  it('are drawn from a fence on some page', () => {
    const used = fences.flatMap(({ meta }) => /diagram=([\w,-]+)/.exec(meta)?.[1].split(',') ?? [])

    expect(used.length).toBeGreaterThan(0)
    expect(
      readdirSync(dir)
        .map((f) => f.replace(/\.svg$/, ''))
        .sort(),
    ).toEqual([...used].sort())
  })

  it.each(fences.map((f) => [f.page, f]))('draw every label in %s', (_, { meta, value }) => {
    const tree = { type: 'root', children: [fence(value, meta)] }

    remarkDiagrams({ dir })(tree, {})

    expect(tree.children[0].type).toBe('html')
  })
})
