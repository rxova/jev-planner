import { describe, expect, it } from 'vitest'

import { rehypeMdLinks } from './rehype-md-links.mjs'

const DOCS_ROOT = '/repo/apps/docs/src/content/docs'

const anchor = (href) => ({ type: 'element', tagName: 'a', properties: { href }, children: [] })

/** Run the plugin over a one-link tree and hand back the rewritten href. */
function resolve(href, { from = 'learn/why.md', base = '/' } = {}) {
  const node = anchor(href)
  const tree = { type: 'root', children: [{ type: 'element', tagName: 'p', children: [node] }] }

  rehypeMdLinks({ base, docsRoot: DOCS_ROOT })(tree, { path: `${DOCS_ROOT}/${from}` })

  return node.properties.href
}

describe('rehypeMdLinks', () => {
  it('turns a doc-relative source path into the route that serves it', () => {
    expect(resolve('../reference/api.md')).toBe('/reference/api/')
    expect(resolve('./getting-started.md')).toBe('/learn/getting-started/')
  })

  it('resolves a bare relative path, written without a leading ./', () => {
    expect(resolve('reference/api.md', { from: 'index.md' })).toBe('/reference/api/')
  })

  it('keeps the fragment', () => {
    expect(resolve('../reference/api.md#exports-rules')).toBe('/reference/api/#exports-rules')
  })

  it('serves the home page at /, not /index/', () => {
    expect(resolve('../index.md')).toBe('/')
  })

  it('applies the mount base, so a link works under the aggregator', () => {
    expect(resolve('../reference/api.md', { base: '/packages/jev-planner/' })).toBe(
      '/packages/jev-planner/reference/api/',
    )
  })

  it.each([
    // Already a URL this site serves.
    '/reference/api/',
    // Someone else's markdown file. Rewriting it to a route here would point at
    // a page that does not exist and hide that the link left the site.
    'https://github.com/rxova/jev-planner/blob/main/README.md',
    '#a-fragment-on-this-page',
    '../assets/logo.svg',
  ])('leaves %s alone', (href) => {
    expect(resolve(href)).toBe(href)
  })

  it('does nothing to a page with no source file, rather than throwing', () => {
    const node = anchor('../reference/api.md')
    const tree = { type: 'root', children: [node] }

    rehypeMdLinks({ base: '/', docsRoot: DOCS_ROOT })(tree, {})

    expect(node.properties.href).toBe('../reference/api.md')
  })
})
