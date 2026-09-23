import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import GithubSlugger from 'github-slugger'
import { describe, expect, it } from 'vitest'

import {
  GET_STARTED,
  GITHUB,
  INSTALL,
  PITCH,
  STAGES,
  TRANSCRIPT,
  landingMarkdown,
} from './content.mjs'

// A sub-path base, not the production root: it is the case where a link that
// skipped `withBase` would show.
const site = { origin: 'https://example.com', base: '/sub/' }

describe('landingMarkdown', () => {
  const md = landingMarkdown(site)

  it('cites the landing page under the base as its source', () => {
    expect(md).toContain('source: https://example.com/sub/\n')
  })

  it('has the install command and the whole transcript', () => {
    expect(md).toContain(`\n${INSTALL}\n`)
    for (const { text } of TRANSCRIPT) expect(md).toContain(text)
    expect(md).toContain(`$ ${TRANSCRIPT[0]?.text ?? ''}`)
  })

  it('makes the whole pitch', () => {
    expect(md).toContain(`## ${PITCH.heading}`)
    for (const { title, body } of PITCH.points) expect(md).toContain(`**${title}.** ${body}`)
  })

  it('names every stage and the star call to action', () => {
    for (const { n, label } of STAGES) expect(md).toContain(`${String(n)}. ${label}`)
    expect(md).toContain(`[Star on GitHub](${GITHUB})`)
  })

  it('links every stage and the getting-started page absolutely, under the base', () => {
    for (const { href } of [...STAGES, { href: GET_STARTED }]) {
      expect(md).toContain(`](https://example.com/sub${href})`)
    }
    expect(md).not.toMatch(/\]\(\//)
  })
})

describe('STAGES', () => {
  it('numbers the four stages 1 to 4, in order', () => {
    expect(STAGES.map(({ n }) => n)).toEqual([1, 2, 3, 4])
  })

  it('points every stage at a heading that exists in how-it-works', () => {
    // The only guard on these anchors: starlight-links-validator sees markdown
    // and frontmatter links, not a fragment built in JavaScript.
    const source = readFileSync(
      fileURLToPath(new URL('../../content/docs/learn/how-it-works.md', import.meta.url)),
      'utf8',
    )
    const slugger = new GithubSlugger()
    const ids = new Set(
      [...source.matchAll(/^#{2,3} (.+)$/gm)].map(([, heading]) => slugger.slug(heading)),
    )

    for (const { href } of STAGES) {
      const [path, fragment] = href.split('#')
      expect(path).toBe('/learn/how-it-works/')
      expect(ids, href).toContain(fragment)
    }
  })
})

describe('TRANSCRIPT', () => {
  it('opens with the command, then labels each stage before its own output', () => {
    const [first, ...rest] = TRANSCRIPT
    expect(first?.kind).toBe('command')
    for (const line of rest) {
      if (line.kind === 'output') expect(line.text).toMatch(/^\[jev-planner\] /)
      else expect(['stage', 'note']).toContain(line.kind)
    }
    expect(rest.filter(({ kind }) => kind === 'stage')).toHaveLength(STAGES.length)
    // One note, for the finalizer line, whose text names the agent Jev chose and
    // so cannot be shown as output without inventing a winner.
    expect(rest.filter(({ kind }) => kind === 'note')).toHaveLength(1)
  })

  it('announces the stages in ascending order', () => {
    const numbers = TRANSCRIPT.filter(({ kind }) => kind === 'stage').map(({ text }) =>
      Number(text.slice(0, text.indexOf(' '))),
    )
    expect(numbers).toEqual([...numbers].sort((a, b) => a - b))
    expect(numbers).toEqual(STAGES.map(({ n }) => n))
  })

  it('ends with the line that says where the plan went', () => {
    expect(TRANSCRIPT.at(-1)?.text).toMatch(/^\[jev-planner\] Wrote /)
  })
})
