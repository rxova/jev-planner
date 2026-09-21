#!/usr/bin/env node
// Serve dist/ the way GitHub Pages does, for the Playwright tests.
//
// Usage: pnpm serve:dist [port]   (base from DOCS_BASE_URL, default `/`)
//
// Not `astro preview`: that detaches into the background in some environments,
// and Playwright's webServer needs a process it owns. This is also closer to
// what ships — the dist mounted at the base, `<dir>/index.html` for a
// directory, `404.html` for anything missing, nothing outside the base.

import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

const DIST = fileURLToPath(new URL('../dist', import.meta.url))
const BASE = (process.env.DOCS_BASE_URL ?? '/').replace(/\/?$/, '/')
const PORT = Number(process.argv[2] ?? 4330)

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.wasm': 'application/wasm',
}

const isFile = async (path) => (await stat(path).catch(() => null))?.isFile() === true

async function resolve(pathname) {
  if (!pathname.startsWith(BASE)) return null
  // normalize() folds `..`, and the prefix check keeps the result inside dist.
  const path = normalize(join(DIST, decodeURIComponent(pathname.slice(BASE.length))))
  if (!path.startsWith(DIST)) return null
  if (await isFile(path)) return path
  if (await isFile(join(path, 'index.html'))) return join(path, 'index.html')
  return null
}

createServer((req, res) => {
  const { pathname } = new URL(req.url ?? '/', 'http://localhost')
  void resolve(pathname).then((path) => {
    const file = path ?? join(DIST, '404.html')
    res.writeHead(path ? 200 : 404, {
      'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
    })
    createReadStream(file).pipe(res)
  })
}).listen(PORT, () => {
  console.log(`serving ${DIST} at http://localhost:${String(PORT)}${BASE}`)
})
