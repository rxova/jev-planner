import { describe, expect, it } from 'vitest'

import {
  DOMAIN,
  EXPECTED,
  POLL,
  REPO,
  checkDns,
  checkLiveSite,
  checkPages,
  checkRedirects,
  checkVersion,
  compareSemver,
  markerMismatch,
  normalize,
  setDiff,
} from './check-live-site.mjs'

/** A resolver that answers from a table: `{ 'A jev-planner.com': [...] }`, per server if nested. */
const resolver = (table) => (server, name, type) => {
  const entry = table[`${type} ${name}`]
  const records = Array.isArray(entry) ? entry : entry?.[server]
  if (records instanceof Error) return Promise.reject(records)
  return Promise.resolve(records ?? [])
}

const GOOD_DNS = {
  [`A ${DOMAIN}`]: EXPECTED.A,
  [`AAAA ${DOMAIN}`]: EXPECTED.AAAA,
  [`CNAME www.${DOMAIN}`]: EXPECTED.CNAME,
}

const GOOD_PAGES = {
  cname: DOMAIN,
  https_enforced: true,
  https_certificate: { state: 'approved' },
}

const response = (status, { location, body } = {}) => ({
  status,
  ok: status >= 200 && status < 300,
  headers: new Headers(location ? { location } : {}),
  text: () => Promise.resolve(body ?? ''),
})

/** A fetch that answers from a table of URL → response, the version URL by prefix. */
const fetcher = (table) => (url) => {
  const key = Object.keys(table).find((k) => url === k || url.startsWith(`${k}?`))
  const answer = key === undefined ? undefined : table[key]
  if (answer instanceof Error) return Promise.reject(answer)
  if (typeof answer === 'function') return Promise.resolve(answer())
  return Promise.resolve(answer ?? response(404))
}

const GOOD_REDIRECTS = {
  [`http://${DOMAIN}/`]: response(301, { location: `https://${DOMAIN}/` }),
  [`https://www.${DOMAIN}/`]: response(301, { location: `https://${DOMAIN}/` }),
}

const SHA = 'a'.repeat(40)
const VERSION_URL = `https://${DOMAIN}/version.json`
const marker = (version, commit = SHA) =>
  response(200, { body: JSON.stringify({ version, commit }) })

/** A clock that only moves when the checker sleeps. */
function clock() {
  let t = 0
  return { now: () => t, sleep: (ms) => Promise.resolve((t += ms)) }
}

describe('normalize and setDiff', () => {
  it('ignores case, trailing dots and IPv6 spelling', () => {
    expect(normalize('RXOVA.GitHub.io.')).toBe('rxova.github.io')
    expect(normalize('2606:50C0:8000:0:0:0:0:153')).toBe('2606:50c0:8000::153')
    expect(normalize(' 185.199.108.153 ')).toBe('185.199.108.153')
    expect(normalize('not:an:[address')).toBe('not:an:[address')
  })

  it('compares as sets, whatever the order or duplication', () => {
    expect(setDiff([...EXPECTED.A].reverse().concat(EXPECTED.A[0]), EXPECTED.A)).toEqual({
      missing: [],
      extra: [],
    })
    expect(setDiff(['185.199.108.153', '1.2.3.4'], EXPECTED.A.slice(0, 2))).toEqual({
      missing: ['185.199.109.153'],
      extra: ['1.2.3.4'],
    })
  })
})

describe('checkDns', () => {
  it('passes the Pages records in any order and spelling', async () => {
    const failures = await checkDns(
      resolver({
        [`A ${DOMAIN}`]: [...EXPECTED.A].reverse(),
        [`AAAA ${DOMAIN}`]: EXPECTED.AAAA.map((ip) => ip.toUpperCase().replace('::', ':0:0:0:0:')),
        [`CNAME www.${DOMAIN}`]: ['rxova.github.io.'],
      }),
    )
    expect(failures).toEqual([])
  })

  it('names missing and unexpected records', async () => {
    const failures = await checkDns(
      resolver({
        ...GOOD_DNS,
        [`A ${DOMAIN}`]: [...EXPECTED.A.slice(1), '76.76.21.21'],
        [`AAAA ${DOMAIN}`]: [],
        [`CNAME www.${DOMAIN}`]: ['jev-planner.com'],
      }),
    )
    expect(failures).toEqual([
      `A ${DOMAIN} is missing 185.199.108.153`,
      `A ${DOMAIN} has unexpected 76.76.21.21`,
      `AAAA ${DOMAIN} is missing ${[...EXPECTED.AAAA].sort().join(', ')}`,
      `CNAME www.${DOMAIN} is missing rxova.github.io`,
      `CNAME www.${DOMAIN} has unexpected jev-planner.com`,
    ])
  })

  it('fails when the resolvers disagree, and when one errors', async () => {
    const failures = await checkDns(
      resolver({
        ...GOOD_DNS,
        [`A ${DOMAIN}`]: { '1.1.1.1': EXPECTED.A, '8.8.8.8': [] },
        [`AAAA ${DOMAIN}`]: { '1.1.1.1': new Error('ETIMEOUT'), '8.8.8.8': EXPECTED.AAAA },
        [`CNAME www.${DOMAIN}`]: {
          '1.1.1.1': new Error('ESERVFAIL'),
          '8.8.8.8': new Error('ESERVFAIL'),
        },
      }),
    )
    expect(failures).toEqual([
      `A ${DOMAIN}: 1.1.1.1 answers ${EXPECTED.A.join(', ')}, 8.8.8.8 answers (nothing)`,
      `AAAA ${DOMAIN} via 1.1.1.1: ETIMEOUT`,
      `CNAME www.${DOMAIN} via 1.1.1.1: ESERVFAIL`,
      `CNAME www.${DOMAIN} via 8.8.8.8: ESERVFAIL`,
    ])
  })

  it('reports the second resolver when the first answers nothing', async () => {
    const failures = await checkDns(
      resolver({ ...GOOD_DNS, [`A ${DOMAIN}`]: { '1.1.1.1': [], '8.8.8.8': ['1.2.3.4'] } }),
    )
    expect(failures).toEqual([`A ${DOMAIN}: 1.1.1.1 answers (nothing), 8.8.8.8 answers 1.2.3.4`])
  })
})

describe('checkPages', () => {
  it('passes the domain with HTTPS enforced and an approved or unreported certificate', async () => {
    expect(await checkPages(() => Promise.resolve(GOOD_PAGES))).toEqual([])
    const noCert = { cname: DOMAIN, https_enforced: true }
    expect(await checkPages(() => Promise.resolve(noCert))).toEqual([])
  })

  it('asks for this repository', async () => {
    const asked = []
    await checkPages((path) => {
      asked.push(path)
      return Promise.resolve(GOOD_PAGES)
    })
    expect(asked).toEqual([`repos/${REPO}/pages`])
  })

  it('names each wrong setting', async () => {
    const failures = await checkPages(() =>
      Promise.resolve({ cname: null, https_enforced: false, https_certificate: { state: 'new' } }),
    )
    expect(failures).toEqual([
      'Pages custom domain is null',
      'Pages does not enforce HTTPS',
      'Pages certificate is new, not approved',
    ])
  })

  it('reports an API error instead of throwing', async () => {
    const failures = await checkPages(() => Promise.reject(new Error('HTTP 403: Forbidden')))
    expect(failures).toEqual([`gh api repos/${REPO}/pages: HTTP 403: Forbidden`])
  })
})

describe('checkRedirects', () => {
  it('passes http → https and www → apex', async () => {
    expect(await checkRedirects(fetcher(GOOD_REDIRECTS))).toEqual([])
  })

  it('fails an answer that is not the redirect, and a network error', async () => {
    const failures = await checkRedirects(
      fetcher({
        [`http://${DOMAIN}/`]: response(200),
        [`https://www.${DOMAIN}/`]: new Error('fetch failed'),
      }),
    )
    expect(failures).toEqual([
      `http://${DOMAIN}/ answers 200, not a redirect to https://${DOMAIN}/`,
      `https://www.${DOMAIN}/: fetch failed`,
    ])
  })

  it('fails a redirect to the wrong place', async () => {
    const failures = await checkRedirects(
      fetcher({
        ...GOOD_REDIRECTS,
        [`https://www.${DOMAIN}/`]: response(301, { location: `http://${DOMAIN}/` }),
      }),
    )
    expect(failures).toEqual([
      `https://www.${DOMAIN}/ answers 301 to http://${DOMAIN}/, not a redirect to https://${DOMAIN}/`,
    ])
  })
})

describe('compareSemver', () => {
  it('orders releases numerically and prereleases before their release', () => {
    expect(compareSemver('1.10.0', '1.9.9')).toBe(1)
    expect(compareSemver('1.0.0', '1.0.1')).toBe(-1)
    expect(compareSemver('1.2.3', '1.2.3+build.5')).toBe(0)
    expect(compareSemver('2.0.0', '2.0.0-rc.1')).toBe(1)
    expect(compareSemver('2.0.0-rc.1', '2.0.0')).toBe(-1)
    expect(compareSemver('2.0.0-rc.2', '2.0.0-rc.1')).toBe(1)
    expect(compareSemver('2.0.0-rc.1', '2.0.0-rc.2')).toBe(-1)
  })
})

describe('markerMismatch', () => {
  const exact = { version: '1.2.0', commit: SHA, atLeast: false }

  it('requires the exact version and commit after a deploy', () => {
    expect(markerMismatch({ version: '1.2.0', commit: SHA }, exact)).toBeNull()
    expect(markerMismatch({ version: '1.2.0', commit: 'b'.repeat(7) }, exact)).toBe(
      `serves 1.2.0 at bbbbbbb, not 1.2.0 at ${SHA}`,
    )
  })

  it('accepts the same or a newer version, from any commit, with --at-least', () => {
    const atLeast = { ...exact, atLeast: true }
    expect(markerMismatch({ version: '1.2.0', commit: 'local' }, atLeast)).toBeNull()
    expect(markerMismatch({ version: '1.3.0', commit: 'local' }, atLeast)).toBeNull()
    expect(markerMismatch({ version: '1.1.9', commit: SHA }, atLeast)).toBe(
      'serves 1.1.9, older than 1.2.0',
    )
  })

  it('rejects what is not a marker', () => {
    expect(markerMismatch('<html>', exact)).toBe('version.json is not a marker: "<html>"')
    expect(markerMismatch(null, exact)).toBe('version.json is not a marker: null')
    expect(markerMismatch({ version: '1.2.0' }, exact)).toBe(
      'version.json is not a marker: {"version":"1.2.0"}',
    )
  })
})

describe('checkVersion', () => {
  const expected = { version: '1.2.0', commit: SHA, atLeast: false }

  it('busts the cache and passes on the first matching answer', async () => {
    const calls = []
    const failures = await checkVersion(
      {
        ...clock(),
        fetch: (url, init) => {
          calls.push({ url, init })
          return Promise.resolve(marker('1.2.0'))
        },
      },
      expected,
    )
    expect(failures).toEqual([])
    expect(calls).toEqual([
      { url: `${VERSION_URL}?t=${SHA}`, init: { headers: { 'cache-control': 'no-cache' } } },
    ])
  })

  it('keeps polling through stale, failed and malformed answers until the new one', async () => {
    const answers = [
      () => marker('1.1.0'),
      () => response(503),
      () => {
        throw new Error('fetch failed')
      },
      () => response(200, { body: '<html>' }),
      () => marker('1.2.0'),
    ]
    const time = clock()
    const failures = await checkVersion(
      { ...time, fetch: () => Promise.resolve().then(answers.shift()) },
      expected,
    )
    expect(failures).toEqual([])
    expect(time.now()).toBe(4 * POLL.intervalMs)
  })

  it('gives up at the timeout with the last problem it saw', async () => {
    const time = clock()
    const failures = await checkVersion(
      { ...time, fetch: fetcher({ [VERSION_URL]: marker('1.1.0') }) },
      expected,
      { timeoutMs: 40_000, intervalMs: 15_000 },
    )
    expect(failures).toEqual([
      `${VERSION_URL}?t=${SHA} serves 1.1.0 at ${SHA}, not 1.2.0 at ${SHA}, after 40 s`,
    ])
    // 15 + 15 + the 10 left, not a third full interval past the deadline.
    expect(time.now()).toBe(40_000)
  })
})

describe('checkLiveSite', () => {
  const deps = (overrides = {}) => ({
    ...clock(),
    resolve: resolver(GOOD_DNS),
    gh: () => Promise.resolve(GOOD_PAGES),
    fetch: fetcher({ ...GOOD_REDIRECTS, [VERSION_URL]: marker('1.2.0') }),
    version: () => '1.2.0',
    ...overrides,
  })

  it('passes a healthy site, with and without the version check', async () => {
    expect(await checkLiveSite(['--config-only'], deps())).toEqual([])
    expect(await checkLiveSite(['--commit', SHA], deps())).toEqual([])
    expect(await checkLiveSite(['--commit', SHA, '--version', '1.2.0'], deps())).toEqual([])
  })

  it('does not fetch the marker with --config-only', async () => {
    const fetched = []
    const fetch = fetcher(GOOD_REDIRECTS)
    await checkLiveSite(
      ['--config-only'],
      deps({
        fetch: (url, init) => {
          fetched.push(url)
          return fetch(url, init)
        },
      }),
    )
    expect(fetched).toEqual([`http://${DOMAIN}/`, `https://www.${DOMAIN}/`])
  })

  it('accepts a newer live version with --at-least', async () => {
    const failures = await checkLiveSite(
      ['--commit', SHA, '--version', '1.1.0', '--at-least'],
      deps(),
    )
    expect(failures).toEqual([])
  })

  it('runs every check and reports every failure', async () => {
    const failures = await checkLiveSite(
      ['--commit', SHA],
      deps({
        resolve: resolver({ ...GOOD_DNS, [`CNAME www.${DOMAIN}`]: [] }),
        gh: () => Promise.resolve({ ...GOOD_PAGES, https_enforced: false }),
        fetch: fetcher({ ...GOOD_REDIRECTS, [VERSION_URL]: marker('1.1.0') }),
      }),
    )
    expect(failures).toEqual([
      `CNAME www.${DOMAIN} is missing rxova.github.io`,
      'Pages does not enforce HTTPS',
      expect.stringMatching(/serves 1\.1\.0 .* after 600 s$/),
    ])
  })

  it('requires a commit unless --config-only, and rejects unknown flags', async () => {
    expect(await checkLiveSite([], deps())).toEqual(['--commit is required unless --config-only'])
    await expect(checkLiveSite(['--deploy'], deps())).rejects.toThrow(/Unknown option/)
  })
})
