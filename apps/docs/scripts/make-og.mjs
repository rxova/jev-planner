#!/usr/bin/env node
// Render public/og.png, the social card, from a typographic SVG.
//
// Usage: pnpm --filter @repo/docs og
//
// Run by hand when the card should change, and commit the PNG: the build only
// copies it. Rendering at build time would make every build depend on which
// fonts the machine has, and the card would drift between CI and a laptop.
// check-site-build holds it to 1200×630 and the size budget.

import { writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import sharp from 'sharp'

import { readCardTokens } from '../src/lib/brand-tokens.mjs'

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'og.png')

const WIDTH = 1200
const HEIGHT = 630
const SANS = "-apple-system, 'Segoe UI', 'Helvetica Neue', Arial, sans-serif"
const MONO = "'SFMono-Regular', Menlo, Consolas, 'DejaVu Sans Mono', monospace"

// The dark theme's colours, from @rxova/brand. The gradient is decoration only
// — the bar along the top — never text, as the brand asks.
const rx = readCardTokens()

const lines = [
  [rx.fg, '[codex]  drafting…'],
  [rx.fg, '[claude] drafting…'],
  [rx.fg, '[jev]    scoring, routing, deciding'],
  [rx.muted, '→ one merged plan'],
]

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <defs>
    <linearGradient id="accent" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="${rx['accent-a']}"/>
      <stop offset="0.5" stop-color="${rx['accent-b']}"/>
      <stop offset="1" stop-color="${rx['accent-c']}"/>
    </linearGradient>
  </defs>
  <rect width="100%" height="100%" fill="${rx.bg}"/>
  <rect x="0" y="0" width="${WIDTH}" height="8" fill="url(#accent)"/>
  <text x="80" y="190" font-family="${SANS}" font-size="96" font-weight="700" fill="${rx.fg}">jev-planner</text>
  <text x="80" y="262" font-family="${SANS}" font-size="38" fill="${rx.muted}">Implementation plans from AIs that review each other,</text>
  <text x="80" y="312" font-family="${SANS}" font-size="38" fill="${rx.muted}">arbitrated by TypeSafe Jev.</text>
  <rect x="80" y="370" width="1040" height="190" rx="12" fill="${rx.card}" stroke="${rx.rule}" stroke-width="2"/>
  ${lines
    .map(
      ([fill, text], i) =>
        `<text x="112" y="${String(415 + i * 40)}" xml:space="preserve" font-family="${MONO}" font-size="28" fill="${fill}">${text}</text>`,
    )
    .join('\n  ')}
</svg>`

const png = await sharp(Buffer.from(svg)).png({ compressionLevel: 9, palette: true }).toBuffer()
await writeFile(OUT, png)
console.log(`✔ wrote ${OUT} (${String(Math.round(png.length / 1024))} kB)`)
