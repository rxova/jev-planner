import { describe, expect, it } from 'vitest'

import {
  HOME,
  MAX_DESCRIPTION,
  firstSentence,
  htmlRoute,
  mdRoute,
  renderMarkdown,
  sectionOf,
} from './docs-pages.mjs'

describe('routes', () => {
  it('serves the home page at / and twins it at /index.md', () => {
    // Astro's content layer ids index.md as `index`, not ''. Assuming '' puts
    // `source: /index/` — a route this site does not serve — into every twin.
    expect(htmlRoute(HOME)).toBe('/')
    expect(htmlRoute('')).toBe('/')
    expect(mdRoute(HOME)).toBe('/index.md')
    expect(mdRoute('')).toBe('/index.md')
  })

  it('leaves every other route alone', () => {
    expect(htmlRoute('guides/serialization')).toBe('/guides/serialization/')
    expect(mdRoute('guides/serialization')).toBe('/guides/serialization.md')
  })
})

describe('sectionOf', () => {
  it.each([
    ['index', 'root'],
    // A file at the content root is framing material — there is no directory to
    // name a section after.
    ['changelog', 'root'],
    ['rules/assertion-weakened', 'rules'],
    ['under-the-hood/untrusted-input', 'under-the-hood'],
  ])('%s -> %s', (id, expected) => {
    expect(sectionOf(id)).toBe(expected)
  })

  it('sections a brand-new directory after itself, with no edit here', () => {
    expect(sectionOf('recipes/monorepo')).toBe('recipes')
  })
})

describe('firstSentence', () => {
  it('ignores code fences', () => {
    // Line-filtering on a leading ``` drops the delimiters and keeps the code,
    // describing a rule page to an agent as "- statements: 95,".
    const body = [
      '```diff',
      '- statements: 95,',
      '```',
      'A coverage threshold is a promise about the suite.',
    ].join('\n')

    expect(firstSentence(body)).toBe('A coverage threshold is a promise about the suite.')
  })

  it('collapses a link to its text', () => {
    const body = 'It grades every [deleted file](../guides/serialization.md#deleted) on recovery.'

    expect(firstSentence(body)).toBe('It grades every deleted file on recovery.')
  })

  it('strips emphasis before matching, not after', () => {
    // With the markers in, the sentence-ending period is followed by `*` rather
    // than whitespace, so nothing matches and the page loses its description.
    expect(firstSentence('**defineError** returns a new class and nothing else.')).toBe(
      'defineError returns a new class and nothing else.',
    )
  })

  it('truncates rather than returning nothing when no sentence fits', () => {
    const body = `${'word '.repeat(80)}ends here.`
    const found = firstSentence(body)

    expect(found).toBeDefined()
    expect(found.length).toBeLessThanOrEqual(MAX_DESCRIPTION + 1)
    expect(found.endsWith('…')).toBe(true)
    // Cut on a word boundary, not mid-word.
    expect(found).not.toMatch(/\bwor…$/)
  })

  it('gives up on a body with nothing to summarise', () => {
    expect(firstSentence('```console\n$ npm install jev-planner\n```')).toBeUndefined()
  })
})

describe('renderMarkdown', () => {
  const page = {
    title: 'TEST_SKIPPED_ADDED',
    description: 'A test stopped running.',
    htmlUrl: 'https://rxova.org/rules/test-skipped-added/',
    body: 'Body text.',
  }

  it('synthesizes the frontmatter and H1 Starlight keeps out of the body', () => {
    expect(renderMarkdown(page)).toBe(
      [
        '---',
        'title: "TEST_SKIPPED_ADDED"',
        'description: "A test stopped running."',
        'source: https://rxova.org/rules/test-skipped-added/',
        '---',
        '',
        '# TEST_SKIPPED_ADDED',
        '',
        'Body text.',
        '',
      ].join('\n'),
    )
  })

  it('omits description when there is none, rather than emitting an empty key', () => {
    expect(renderMarkdown({ ...page, description: undefined })).not.toContain('description:')
  })

  it('quotes a title containing a colon, which would otherwise break the YAML', () => {
    expect(
      renderMarkdown({ ...page, title: 'Subclassing Error: what the constructor does' }),
    ).toContain('title: "Subclassing Error: what the constructor does"')
  })
})
