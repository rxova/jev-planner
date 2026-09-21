// https://rxova.org/packages/jev-planner/llms-full.txt — every page, inlined.
//
// For the case where one fetch should be the whole documentation set rather than
// an index to follow. `scripts/check-md-routes.mjs` holds it to a size budget, so
// if the docs grow past what fits in a context window the build says so rather
// than an agent silently truncating it.

import type { APIRoute } from 'astro'

import { docsPages } from '../lib/docs-md.mjs'
import { llmsFull } from '../lib/llms.mjs'

export const prerender = true

export const GET: APIRoute = async () => {
  const pages = await docsPages({
    origin: import.meta.env.SITE,
    base: import.meta.env.BASE_URL,
  })

  return new Response(llmsFull(pages), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  })
}
