import { describe, expect, it } from 'vitest'

import { FEATURES, GET_STARTED, INSTALL, TRANSCRIPT, landingMarkdown } from './content.mjs'

const site = { origin: 'https://rxova.github.io', base: '/jev-planner/' }

describe('landingMarkdown', () => {
  const md = landingMarkdown(site)

  it('cites the landing page under the base as its source', () => {
    expect(md).toContain('source: https://rxova.github.io/jev-planner/\n')
  })

  it('has the install command and the whole transcript', () => {
    expect(md).toContain(`\n${INSTALL}\n`)
    for (const { text } of TRANSCRIPT) expect(md).toContain(text)
    expect(md).toContain(`$ ${TRANSCRIPT[0]?.text ?? ''}`)
  })

  it('links every feature and the getting-started page absolutely, under the base', () => {
    for (const { href } of [...FEATURES, { href: GET_STARTED }]) {
      expect(md).toContain(`](https://rxova.github.io/jev-planner${href})`)
    }
    expect(md).not.toMatch(/\]\(\//)
  })
})

describe('TRANSCRIPT', () => {
  it('opens with the command and prints only jev-planner lines or notes after it', () => {
    const [first, ...rest] = TRANSCRIPT
    expect(first?.kind).toBe('command')
    for (const line of rest) {
      if (line.kind === 'output') expect(line.text).toMatch(/^\[jev-planner\] /)
      else expect(line.kind).toBe('note')
    }
  })
})
