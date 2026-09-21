// https://jev-planner.com/version.json — which release these docs describe.
//
// See src/lib/version-marker.mjs for why it exists. The version is imported
// rather than read from disk at render time: the prerender runs from a bundle
// under dist, where a path relative to this file no longer points anywhere.

import type { APIRoute } from 'astro'

import manifest from '../../../../packages/jev-planner/package.json'
import { versionMarker } from '../lib/version-marker.mjs'

export const prerender = true

export const GET: APIRoute = () =>
  new Response(JSON.stringify(versionMarker(manifest.version, process.env.DOCS_COMMIT)), {
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  })
