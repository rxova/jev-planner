import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  MANIFEST,
  assertReleaseVersion,
  manifestVersion,
  markerProblems,
  versionMarker,
} from './version-marker.mjs'

async function manifest(body) {
  const path = join(await mkdtemp(join(tmpdir(), 'jev-planner-manifest-')), 'package.json')
  await writeFile(path, JSON.stringify(body))
  return path
}

describe('manifestVersion', () => {
  it('reads the published package by default', () => {
    expect(MANIFEST).toMatch(/packages[/\\]jev-planner[/\\]package\.json$/)
    expect(manifestVersion()).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('reads a prerelease', async () => {
    expect(manifestVersion(await manifest({ version: '2.0.0-next.1' }))).toBe('2.0.0-next.1')
  })

  it('throws on a missing or non-semver version', async () => {
    for (const body of [{}, { version: 3 }, { version: 'latest' }]) {
      const path = await manifest(body)
      expect(() => manifestVersion(path)).toThrow(`${path} has no semver "version"`)
    }
  })
})

describe('versionMarker', () => {
  it('names the commit, or says the build is local', () => {
    expect(versionMarker('1.0.0', 'abc1234')).toEqual({ version: '1.0.0', commit: 'abc1234' })
    expect(versionMarker('1.0.0', undefined)).toEqual({ version: '1.0.0', commit: 'local' })
    expect(versionMarker('1.0.0', '')).toEqual({ version: '1.0.0', commit: 'local' })
  })
})

describe('assertReleaseVersion', () => {
  it('passes when no release is named or the versions agree', () => {
    expect(() => {
      assertReleaseVersion(undefined, '1.0.0')
    }).not.toThrow()
    expect(() => {
      assertReleaseVersion('', '1.0.0')
    }).not.toThrow()
    expect(() => {
      assertReleaseVersion('1.0.0', '1.0.0')
    }).not.toThrow()
  })

  it('throws when the checkout is another version', () => {
    expect(() => {
      assertReleaseVersion('9.9.9', '1.0.0')
    }).toThrow('DOCS_RELEASE_VERSION is 9.9.9, but packages/jev-planner is at 1.0.0')
  })
})

describe('markerProblems', () => {
  const marker = (m) => JSON.stringify(m)

  it('accepts a local or CI marker', () => {
    expect(markerProblems(marker({ version: '1.0.0', commit: 'local' }), '1.0.0')).toEqual([])
    expect(markerProblems(marker({ commit: 'abcdef1', version: '1.0.0' }), '1.0.0')).toEqual([])
    expect(markerProblems(marker({ version: '1.0.0', commit: 'f'.repeat(40) }), '1.0.0')).toEqual(
      [],
    )
  })

  it('rejects what is not a JSON object', () => {
    expect(markerProblems('', '1.0.0')).toEqual(['version.json is not JSON'])
    expect(markerProblems('"1.0.0"', '1.0.0')).toEqual(['version.json is not an object'])
    expect(markerProblems('[]', '1.0.0')).toEqual(['version.json is not an object'])
    expect(markerProblems('null', '1.0.0')).toEqual(['version.json is not an object'])
  })

  it('names every problem with an object', () => {
    expect(markerProblems('{}', '1.0.0')).toEqual([
      'version.json has keys (none)',
      'version.json says undefined, the package is 1.0.0',
      'version.json commit undefined is not "local" or a git sha',
    ])
    expect(markerProblems(marker({ version: '1.0.0', commit: 'ABCDEF1', at: 0 }), '1.0.0')).toEqual(
      [
        'version.json has keys at,commit,version',
        'version.json commit ABCDEF1 is not "local" or a git sha',
      ],
    )
  })
})
