// Marks the built dist as a page-component bundle for the rxova.org aggregator.
//
// Gate 1 of the ingest contract (rxova/rxova-website docs/INPUTS-CONTRACT.md):
// the aggregator never builds these docs, it downloads this dist and composes
// each rendered body into its own shell. The manifest is how it knows which
// project the artifact belongs to and what base path it was built for — a dist
// built at the wrong base is the one failure the receiver cannot detect by
// looking at the HTML.

import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const dist = new URL('../dist/', import.meta.url)
const filename = 'rxova-page-bundle.json'
const manifest = {
  schema: 2,
  format: 'html-page-component',
  project: 'jev-planner',
  base: '/packages/jev-planner/',
}
await writeFile(new URL(filename, dist), `${JSON.stringify(manifest, null, 2)}\n`)
console.log(`Wrote ${join('apps/docs/dist', filename)}`)
