// https://jev-planner.com/llms.txt — the agent-facing index.
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

  // The mount, not the bare origin: served from a sub-path, a URL that dropped
  // the base would 404 in the one place it is meant to be followed.
  const mount = `${import.meta.env.SITE}${import.meta.env.BASE_URL}`.replace(/\/$/, '')

  return new Response(llmsIndex(pages, mount), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  })
}
