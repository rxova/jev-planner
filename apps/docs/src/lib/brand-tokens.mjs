// The rxova brand colours, read from @rxova/brand's tokens.css rather than
// copied, so the social card follows the package when it is bumped.
//
// Only what make-og needs: the dark theme's neutrals and the three gradient
// stops, which are the same in both themes.

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

/** Token names the card uses, without their `--rx-` prefix. */
export const CARD_TOKENS = ['bg', 'card', 'fg', 'muted', 'rule', 'accent-a', 'accent-b', 'accent-c']

/** The declarations inside the first `selector { … }` block, as a name → value map. */
export function declarations(css, selector) {
  const start = css.indexOf(`${selector} {`)
  if (start === -1) return null
  const open = css.indexOf('{', start)
  const block = css.slice(open + 1, css.indexOf('}', open))
  const out = {}
  for (const [, name, value] of block.matchAll(/--rx-([\w-]+)\s*:\s*([^;]+);/g)) {
    out[name] = value.trim()
  }
  return out
}

/**
 * The card's tokens from a tokens.css source: the dark block's values over the
 * mode-independent `:root` block's. Throws naming every token it cannot find,
 * so a renamed token fails `pnpm og` instead of rendering an unstyled card.
 */
export function parseCardTokens(css) {
  const dark = declarations(css, ":root[data-theme='dark']")
  if (!dark) throw new Error("tokens.css has no :root[data-theme='dark'] block")
  const shared = declarations(css, ':root') ?? {}
  const tokens = { ...shared, ...dark }

  const missing = CARD_TOKENS.filter((name) => !(name in tokens))
  if (missing.length > 0) {
    throw new Error(`tokens.css is missing ${missing.map((n) => `--rx-${n}`).join(', ')}`)
  }
  return Object.fromEntries(CARD_TOKENS.map((name) => [name, tokens[name]]))
}

/** The card's tokens from the installed @rxova/brand. */
export function readCardTokens() {
  const path = createRequire(import.meta.url).resolve('@rxova/brand/tokens.css')
  return parseCardTokens(readFileSync(path, 'utf8'))
}
