import { describe, expect, it } from 'vitest'

import { groupPages, llmsFull, llmsIndex } from './llms.mjs'

const page = (id, overrides = {}) => ({
  id,
  section: id.includes('/') ? id.split('/')[0] : 'root',
  title: id,
  description: `About ${id}.`,
  mdUrl: `https://rxova.org/${id}.md`,
  htmlUrl: `https://rxova.org/${id}/`,
  body: `Body of ${id}.`,
  ...overrides,
})

const pages = [
  page('index', { section: 'root', title: 'jev-planner' }),
  page('reference/api'),
  page('guides/cli-options'),
  page('learn/how-it-works'),
]

describe('groupPages', () => {
  it('orders sections editorially, not alphabetically', () => {
    // The sidebar order is a judgement about what to read first. An agent has no
    // reason to get a worse one than a human.
    expect(groupPages(pages).map((g) => g.heading)).toEqual([
      'About',
      'Learn',
      'Guides',
      'Reference',
    ])
  })

  it('gives an unknown directory a heading named after itself', () => {
    // Unlabelled beats missing: a new directory shows up in the index without
    // anyone having to edit SECTIONS first.
    const groups = groupPages([...pages, page('recipes/monorepo')])

    expect(groups.at(-1)).toMatchObject({ heading: 'recipes' })
    expect(groups.at(-1).pages).toHaveLength(1)
  })

  it('drops no page', () => {
    const extra = [...pages, page('recipes/monorepo'), page('guides/cost-and-data-flow')]

    expect(groupPages(extra).flatMap((g) => g.pages)).toHaveLength(extra.length)
  })
})

describe('llmsIndex', () => {
  const index = llmsIndex(pages, 'https://rxova.org')

  it('leads with the H1 and the summary blockquote llmstxt.org expects', () => {
    const lines = index.split('\n')

    expect(lines[0]).toBe('# jev-planner')
    expect(lines[2].startsWith('> ')).toBe(true)
  })

  it('gives the install line, since an agent reaching this has not installed it yet', () => {
    expect(index).toContain('npm install -g jev-planner')
    expect(index).toContain('npx jev-planner')
  })

  it('installs from npm under the unscoped name', () => {
    expect(index).not.toContain('@rxova/')
  })

  it('states the facts that decide whether a run fails or surprises', () => {
    // Prerequisites, cost, where the output goes, and that nothing is edited:
    // each one is something an agent would otherwise learn from a failed run.
    expect(index).toContain('TYPESAFE_API_KEY')
    expect(index).toContain('jev-planner doctor')
    expect(index).toContain('billed')
    expect(index).toContain('stdout')
    expect(index).toContain('read-only')
  })

  it('points at llms-full.txt absolutely', () => {
    // This document is read detached from the site as often as it is fetched
    // from it, and a pasted copy has nothing to resolve a relative path against.
    expect(index).toContain('https://rxova.org/llms-full.txt')
  })

  it('links the .md twins, not the HTML pages', () => {
    expect(index).toContain('- [reference/api](https://rxova.org/reference/api.md): About')
    expect(index).not.toMatch(/\]\(https:\/\/rxova\.org\/reference\/api\/\)/)
  })

  it('omits the colon for a page with no description', () => {
    const bare = llmsIndex([page('index', { description: undefined })], 'https://rxova.org')

    expect(bare).toContain('- [index](https://rxova.org/index.md)\n')
  })
})

describe('llmsFull', () => {
  const full = llmsFull(pages)

  it('inlines every body in the index order', () => {
    const order = ['index', 'learn/how-it-works', 'guides/cli-options', 'reference/api'].map((id) =>
      full.indexOf(`Body of ${id}.`),
    )

    expect(order.every((i) => i >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  it('states each page canonical HTML URL, so a reader can cite the page', () => {
    expect(full).toContain('Source: https://rxova.org/reference/api/')
  })

  it('repeats the same summary the index carries', () => {
    expect(full.split('\n')[0]).toBe('# jev-planner')
    expect(full).toContain('> A command-line tool that writes an implementation plan')
  })
})
