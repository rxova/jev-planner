// The landing page's `.md` twin.
//
// The landing page is an Astro page, not a content entry, so `[...slug].md.ts`
// never sees it. Rather than excuse it from check-md-routes, it gets a twin of
// its own, built from the same copy the page renders.

import type { APIRoute } from 'astro'

import { landingMarkdown } from '../components/landing/content.mjs'

export const prerender = true

export const GET: APIRoute = () =>
  new Response(landingMarkdown({ origin: import.meta.env.SITE, base: import.meta.env.BASE_URL }), {
    headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
  })
