import { describe, expect, it } from 'vitest'

import { CARD_TOKENS, declarations, parseCardTokens, readCardTokens } from './brand-tokens.mjs'

const CSS = `
:root[data-theme='light'] {
  --rx-bg: #ffffff;
  --rx-fg: #111111;
}
:root[data-theme='dark'] {
  --rx-bg: #000000;
  --rx-card: #0a0a0a;
  --rx-fg: #eeeeee;
  --rx-muted: #999999;
  --rx-rule: #222222;
}
:root {
  --rx-accent-a: #0000ff;
  --rx-accent-b: #7700ff;
  --rx-accent-c: #ff00aa;
  --rx-gradient: linear-gradient(90deg, var(--rx-accent-a), var(--rx-accent-c));
}
`

describe('declarations', () => {
  it('reads one block, not the ones around it', () => {
    expect(declarations(CSS, ":root[data-theme='light']")).toEqual({
      bg: '#ffffff',
      fg: '#111111',
    })
  })

  it('returns null for a selector that is not there', () => {
    expect(declarations(CSS, '.nope')).toBeNull()
  })
})

describe('parseCardTokens', () => {
  it('takes the dark neutrals and the shared accents', () => {
    expect(parseCardTokens(CSS)).toEqual({
      bg: '#000000',
      card: '#0a0a0a',
      fg: '#eeeeee',
      muted: '#999999',
      rule: '#222222',
      'accent-a': '#0000ff',
      'accent-b': '#7700ff',
      'accent-c': '#ff00aa',
    })
  })

  it('names every missing token', () => {
    const css = CSS.replace('  --rx-muted: #999999;\n', '').replace(/--rx-accent-c:[^;]+;/, '')
    expect(() => parseCardTokens(css)).toThrow('tokens.css is missing --rx-muted, --rx-accent-c')
  })

  it('fails without a dark block', () => {
    expect(() => parseCardTokens(':root { --rx-bg: #000; }')).toThrow(
      /no :root\[data-theme='dark'\]/,
    )
  })

  it('works without a shared block when the dark one has everything', () => {
    const css = `:root[data-theme='dark'] { ${CARD_TOKENS.map((n) => `--rx-${n}: #123456;`).join(' ')} }`
    expect(Object.values(parseCardTokens(css))).toEqual(CARD_TOKENS.map(() => '#123456'))
  })
})

describe('readCardTokens', () => {
  it('reads every card token from the installed @rxova/brand as a hex colour', () => {
    const tokens = readCardTokens()
    expect(Object.keys(tokens)).toEqual(CARD_TOKENS)
    for (const value of Object.values(tokens)) expect(value).toMatch(/^#[0-9a-f]{6}$/i)
  })
})
