/**
 * Fails a pull request that changes a published package without a changeset,
 * which would release it with an unchanged version and nothing in the changelog.
 *
 * A published package is one `check-llms` would check: a directory under
 * `packages/` whose manifest is not private. Markdown and unit tests inside it
 * change nothing an install runs, and docs, CI config and the private packages
 * reach no one who installs, so none of those ask for a changeset.
 *
 * A pull request that does change a published package yet publishes nothing (a
 * dev dependency bump, say) carries the `skip-changeset` label instead.
 *
 * CI hands over the range as BASE_SHA and HEAD_SHA and the labels as PR_LABELS.
 */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { publishedPackages } from '../check-llms/check-llms.js'
import { isEntry } from '../entry/entry.js'
import type { Differ, Verdict } from './check-changeset.types.js'

export const gitDiff: Differ = (base, head) =>
  execFileSync('git', ['diff', '--name-only', `${base}...${head}`], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)

/** Four levels up from `packages/tooling/src/check-changeset`, wherever the script is run from. */
export const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url))

/** Whether the diff touches something a published package ships. `published` holds directory names. */
export const touchesPackage = (changed: string[], published: string[]): boolean =>
  changed.some(
    (file) =>
      published.some((dir) => file.startsWith(`packages/${dir}/`)) &&
      !file.endsWith('.md') &&
      !file.includes('/__tests__/') &&
      !file.endsWith('.test.ts'),
  )

export const hasChangeset = (changed: string[]): boolean =>
  changed.some(
    (file) =>
      file.startsWith('.changeset/') && file.endsWith('.md') && file !== '.changeset/README.md',
  )

/**
 * The label that says this pull request needs no changelog entry.
 *
 * A dev dependency bump changes what the repository builds with and nothing
 * about what it publishes, and a gate that asks anyway teaches people to write
 * empty changesets. Renovate applies this label to every pull request it opens.
 */
export const SKIP_LABEL = 'skip-changeset'

/** The workflow hands labels over as one comma-separated string, or not at all. */
export const labelsOf = (value: string | undefined): string[] =>
  (value ?? '')
    .split(',')
    .map((label) => label.trim())
    .filter(Boolean)

export const check = (changed: string[], published: string[], labels: string[] = []): Verdict => {
  if (!touchesPackage(changed, published)) {
    return { exitCode: 0, message: 'check-changeset: no published package changed' }
  }
  if (labels.includes(SKIP_LABEL)) {
    return { exitCode: 0, message: `check-changeset: \`${SKIP_LABEL}\` set on this pull request` }
  }
  if (hasChangeset(changed)) {
    return { exitCode: 0, message: 'check-changeset: changeset present' }
  }
  return {
    exitCode: 1,
    message: [
      'check-changeset: this pull request changes a published package but adds no changeset.',
      '',
      'Run `pnpm changeset` and commit the file it writes.',
      `If it publishes nothing (a dev dependency bump, say), label it \`${SKIP_LABEL}\`.`,
    ].join('\n'),
  }
}

/** Returns the process exit code rather than setting it, so tests can call it. */
export const main = (
  env: NodeJS.ProcessEnv = process.env,
  {
    diff = gitDiff,
    published = publishedPackages(REPO_ROOT).map(({ dir }) => dir),
  }: { diff?: Differ; published?: string[] } = {},
): number => {
  const base = env.BASE_SHA
  const head = env.HEAD_SHA

  if (!base || !head) {
    console.error('check-changeset: BASE_SHA and HEAD_SHA must be set')
    return 1
  }

  const verdict = check(diff(base, head), published, labelsOf(env.PR_LABELS))
  if (verdict.exitCode === 0) console.log(verdict.message)
  else console.error(verdict.message)
  return verdict.exitCode
}

/* v8 ignore start -- the entry shell; covered by the test that spawns this
   file, which reports no coverage back into this run. */
if (isEntry(import.meta.url)) {
  process.exit(main())
}
/* v8 ignore stop */
