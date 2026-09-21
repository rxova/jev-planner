// The site's version marker, `<base>version.json`: which jev-planner release
// the deployed docs describe, and which commit they were built from. The live
// check polls it after a release to prove the new docs actually reached
// jev-planner.com, rather than trusting a green deploy job.
//
// Everything here is plain data in, plain data out, so the endpoint, the
// config guard and the build check all share one definition of "valid".

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** The published package whose release the docs follow. */
export const MANIFEST = fileURLToPath(
  new URL('../../../../packages/jev-planner/package.json', import.meta.url),
)

/** `local` for a build outside CI; otherwise a git commit, short or full. */
const COMMIT = /^(?:local|[0-9a-f]{7,40})$/

const SEMVER = /^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/

/** The version in a package.json, read fresh: the release job bumps it mid-run. */
export function manifestVersion(path = MANIFEST) {
  const { version } = JSON.parse(readFileSync(path, 'utf8'))
  if (typeof version !== 'string' || !SEMVER.test(version)) {
    throw new Error(`${path} has no semver "version"`)
  }
  return version
}

/** The marker's body. An unset or empty commit means a local build. */
export function versionMarker(version, commit) {
  return { version, commit: commit || 'local' }
}

/**
 * A release deploy names the version it is publishing. Building any other
 * version under that name would put the previous release's docs up and report
 * success, so the build refuses.
 */
export function assertReleaseVersion(released, built) {
  if (released && released !== built) {
    throw new Error(
      `DOCS_RELEASE_VERSION is ${released}, but packages/jev-planner is at ${built}: ` +
        'the checkout is not the release commit',
    )
  }
}

/** Why a built version.json is not a valid marker for `expected`, if it is not. */
export function markerProblems(text, expected) {
  let marker
  try {
    marker = JSON.parse(text)
  } catch {
    return ['version.json is not JSON']
  }
  if (typeof marker !== 'object' || marker === null || Array.isArray(marker)) {
    return ['version.json is not an object']
  }

  const problems = []
  const keys = Object.keys(marker).sort().join(',')
  if (keys !== 'commit,version') problems.push(`version.json has keys ${keys || '(none)'}`)
  if (marker.version !== expected) {
    problems.push(`version.json says ${String(marker.version)}, the package is ${expected}`)
  }
  if (typeof marker.commit !== 'string' || !COMMIT.test(marker.commit)) {
    problems.push(`version.json commit ${String(marker.commit)} is not "local" or a git sha`)
  }
  return problems
}
