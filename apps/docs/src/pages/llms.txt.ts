// https://rxova.org/packages/jev-planner/llms.txt — the agent-facing index.
//
// See src/lib/llms.mjs for the document's shape. This is the adapter: read the
// pages, serve the text.

import type { APIRoute } from 'astro'

import { docsPages } from '../lib/docs-md.mjs'
import { llmsIndex } from '../lib/llms.mjs'

export const prerender = true

export const GET: APIRoute = async () => {
  const pages = await docsPages({
    origin: import.meta.env.SITE,
    base: import.meta.env.BASE_URL,
  })

  // The mount, not the bare origin: under the aggregator this site lives at
  // /packages/jev-planner/, and a URL that dropped that prefix would 404 in the one
  // place it is meant to be followed.
  const mount = `${import.meta.env.SITE}${import.meta.env.BASE_URL}`.replace(/\/$/, '')

  return new Response(llmsIndex(pages, mount), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  })
}
