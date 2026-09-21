#!/usr/bin/env node
// Check that jev-planner.com is what the repository says it is: DNS pointing at
// GitHub Pages, Pages configured for the domain, HTTPS enforced, and — after a
// deploy — the deployed version.json naming the release that was just built.
//
// Usage:
//   node ./scripts/check-live-site.mjs --config-only
//   node ./scripts/check-live-site.mjs --commit <sha> [--version <v>] [--at-least]
//
// A green deploy job says an artifact was uploaded, not that the domain serves
// it. Everything between the two — a DNS record someone edited, a certificate
// that lapsed, a CDN still handing out the old site — is only visible from the
// outside, so this looks from the outside.
//
// `--version` defaults to packages/jev-planner's. `--at-least` accepts a newer
// version with any commit: a run whose deploy was skipped because a newer one
// had already shipped must not demand the older release back.
//
// Every check runs; each failure is printed as a GitHub Actions `::error::`.

import { execFile } from 'node:child_process'
import { Resolver } from 'node:dns/promises'
import { parseArgs, promisify } from 'node:util'

import { manifestVersion } from '../src/lib/version-marker.mjs'

export const DOMAIN = 'jev-planner.com'
export const REPO = 'rxova/jev-planner'

/** Two public resolvers, asked separately: one stale cache should not decide. */
const RESOLVERS = ['1.1.1.1', '8.8.8.8']

/** GitHub Pages' published apex addresses and the organisation's Pages host. */
export const EXPECTED = {
  A: ['185.199.108.153', '185.199.109.153', '185.199.110.153', '185.199.111.153'],
  AAAA: [
    '2606:50c0:8000::153',
    '2606:50c0:8001::153',
    '2606:50c0:8002::153',
    '2606:50c0:8003::153',
  ],
  CNAME: ['rxova.github.io'],
}

/** The records checked, as [name, type]. */
const RECORDS = [
  [DOMAIN, 'A'],
  [DOMAIN, 'AAAA'],
  [`www.${DOMAIN}`, 'CNAME'],
]

export const POLL = { timeoutMs: 10 * 60 * 1000, intervalMs: 15 * 1000 }

/**
 * One spelling per record: lower case, no trailing dot, IPv6 in the URL
 * parser's canonical compressed form, so `2606:50C0:8000:0::153` and
 * `2606:50c0:8000::153` compare equal.
 */
export function normalize(record) {
  const value = record.trim().toLowerCase().replace(/\.$/, '')
  if (!value.includes(':')) return value
  try {
    return new URL(`http://[${value}]/`).hostname.slice(1, -1)
  } catch {
    return value
  }
}

const setOf = (records) => [...new Set(records.map(normalize))].sort()

/** Missing and unexpected entries of `actual` against `expected`, both normalised. */
export function setDiff(actual, expected) {
  const a = setOf(actual)
  const e = setOf(expected)
  return { missing: e.filter((x) => !a.includes(x)), extra: a.filter((x) => !e.includes(x)) }
}

/** DNS: every resolver agrees, and the answer is exactly what Pages publishes. */
export async function checkDns(resolve) {
  const failures = []
  for (const [name, type] of RECORDS) {
    const answers = []
    for (const server of RESOLVERS) {
      try {
        answers.push({ server, records: setOf(await resolve(server, name, type)) })
      } catch (error) {
        failures.push(`${type} ${name} via ${server}: ${error.message}`)
      }
    }
    if (answers.length === 0) continue

    const [first, ...rest] = answers
    const disagreeing = rest.find((a) => a.records.join() !== first.records.join())
    if (disagreeing) {
      failures.push(
        `${type} ${name}: ${first.server} answers ${first.records.join(', ') || '(nothing)'}, ` +
          `${disagreeing.server} answers ${disagreeing.records.join(', ') || '(nothing)'}`,
      )
      continue
    }

    const { missing, extra } = setDiff(first.records, EXPECTED[type])
    if (missing.length > 0) failures.push(`${type} ${name} is missing ${missing.join(', ')}`)
    if (extra.length > 0) failures.push(`${type} ${name} has unexpected ${extra.join(', ')}`)
  }
  return failures
}

/** The repository's Pages settings, from `gh api`. */
export async function checkPages(gh) {
  let pages
  try {
    pages = await gh(`repos/${REPO}/pages`)
  } catch (error) {
    return [`gh api repos/${REPO}/pages: ${error.message}`]
  }

  const failures = []
  if (pages.cname !== DOMAIN) failures.push(`Pages custom domain is ${String(pages.cname)}`)
  if (pages.https_enforced !== true) failures.push('Pages does not enforce HTTPS')
  const cert = pages.https_certificate?.state
  if (cert !== undefined && cert !== 'approved') {
    failures.push(`Pages certificate is ${String(cert)}, not approved`)
  }
  return failures
}

/** Where `from` redirects to, or a failure if it answers without redirecting there. */
async function redirects(fetchFn, from, to) {
  let response
  try {
    response = await fetchFn(from, { redirect: 'manual' })
  } catch (error) {
    return [`${from}: ${error.message}`]
  }
  const location = response.headers.get('location') ?? ''
  const isRedirect = response.status >= 300 && response.status < 400
  if (isRedirect && location.startsWith(to)) return []
  return [
    `${from} answers ${String(response.status)}` +
      (location ? ` to ${location}` : '') +
      `, not a redirect to ${to}`,
  ]
}

/** Plain HTTP goes to HTTPS, and `www` goes to the apex. */
export async function checkRedirects(fetchFn) {
  return [
    ...(await redirects(fetchFn, `http://${DOMAIN}/`, `https://${DOMAIN}/`)),
    ...(await redirects(fetchFn, `https://www.${DOMAIN}/`, `https://${DOMAIN}/`)),
  ]
}

/** -1, 0 or 1. A prerelease sorts before its release; prerelease tags compare as text. */
export function compareSemver(a, b) {
  const parse = (v) => {
    const [core, pre = ''] = v.split('+')[0].split(/-(.*)/s)
    return { nums: core.split('.').map(Number), pre }
  }
  const x = parse(a)
  const y = parse(b)
  for (let i = 0; i < 3; i++) {
    if (x.nums[i] !== y.nums[i]) return x.nums[i] > y.nums[i] ? 1 : -1
  }
  if (x.pre === y.pre) return 0
  if (!x.pre) return 1
  if (!y.pre) return -1
  return x.pre > y.pre ? 1 : -1
}

/** Why a served marker is not the one expected, or null if it is. */
export function markerMismatch(marker, { version, commit, atLeast }) {
  if (typeof marker?.version !== 'string' || typeof marker.commit !== 'string') {
    return `version.json is not a marker: ${JSON.stringify(marker)}`
  }
  if (atLeast) {
    return compareSemver(marker.version, version) >= 0
      ? null
      : `serves ${marker.version}, older than ${version}`
  }
  if (marker.version !== version || marker.commit !== commit) {
    return `serves ${marker.version} at ${marker.commit}, not ${version} at ${commit}`
  }
  return null
}

/**
 * Poll the live marker until it matches or `timeoutMs` passes. The query
 * string and `no-cache` get past the CDN; the timeout covers its propagation.
 */
export async function checkVersion(
  { fetch: fetchFn, sleep, now },
  expected,
  { timeoutMs, intervalMs } = POLL,
) {
  const url = `https://${DOMAIN}/version.json?t=${expected.commit}`
  const start = now()
  let last
  for (;;) {
    try {
      const response = await fetchFn(url, { headers: { 'cache-control': 'no-cache' } })
      if (response.ok) {
        const text = await response.text()
        let marker
        try {
          marker = JSON.parse(text)
        } catch {
          marker = text
        }
        last = markerMismatch(marker, expected)
        if (last === null) return []
      } else {
        last = `answers ${String(response.status)}`
      }
    } catch (error) {
      last = error.message
    }
    const waited = now() - start
    if (waited >= timeoutMs) {
      return [`${url} ${last}, after ${String(Math.round(waited / 1000))} s`]
    }
    await sleep(Math.min(intervalMs, timeoutMs - waited))
  }
}

/** Every check the arguments ask for; the failures, empty when the site is right. */
export async function checkLiveSite(argv, deps) {
  const { values } = parseArgs({
    args: argv,
    options: {
      'config-only': { type: 'boolean', default: false },
      commit: { type: 'string' },
      version: { type: 'string' },
      'at-least': { type: 'boolean', default: false },
    },
    strict: true,
  })

  const failures = [
    ...(await checkDns(deps.resolve)),
    ...(await checkPages(deps.gh)),
    ...(await checkRedirects(deps.fetch)),
  ]
  if (values['config-only']) return failures

  if (!values.commit) return [...failures, '--commit is required unless --config-only']
  const expected = {
    version: values.version ?? deps.version(),
    commit: values.commit,
    atLeast: values['at-least'],
  }
  return [...failures, ...(await checkVersion(deps, expected))]
}

/* v8 ignore start -- the real network, DNS and gh; the tests inject all three. */
const NO_RECORDS = new Set(['ENODATA', 'ENOTFOUND'])

const liveDeps = {
  async resolve(server, name, type) {
    const resolver = new Resolver({ timeout: 5000, tries: 2 })
    resolver.setServers([server])
    try {
      return await resolver.resolve(name, type)
    } catch (error) {
      if (NO_RECORDS.has(error.code)) return []
      throw error
    }
  },
  async gh(path) {
    const { stdout } = await promisify(execFile)('gh', ['api', path])
    return JSON.parse(stdout)
  },
  fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(15_000) }),
  sleep: (ms) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms)
    }),
  now: () => Date.now(),
  version: () => manifestVersion(),
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const failures = await checkLiveSite(process.argv.slice(2), liveDeps)
  if (failures.length > 0) {
    for (const failure of failures) console.log(`::error::${failure}`)
    process.exit(1)
  }
  const what = process.argv.includes('--config-only') ? '' : ' and the deployed version'
  console.log(`✔ ${DOMAIN}: DNS, Pages settings, redirects${what} as expected`)
}
/* v8 ignore stop */
