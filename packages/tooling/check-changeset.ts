/**
 * A change to a published package needs a changeset, or the release goes out
 * with an empty changelog and an unchanged version.
 *
 * Every directory under `packages/` publishes, except tooling and config.
 * Docs, CI config and the apps are exempt: they ship nothing to npm.
 */
import { execFileSync } from 'node:child_process';
import { isEntry } from './entry.js';

/** How the range is read. Injected so the rule can be tested without a repo. */
export type Differ = (base: string, head: string) => string[];

export const gitDiff: Differ = (base, head) =>
  execFileSync('git', ['diff', '--name-only', `${base}...${head}`], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);

/** Workspace packages that are never published. */
export const UNPUBLISHED = ['packages/tooling/', 'packages/config/'];

/**
 * Whether the diff touches something that actually ships. Markdown and unit
 * tests inside a package are excluded: neither reaches the tarball, so neither
 * needs a changelog entry.
 */
export const touchesPackage = (changed: string[]): boolean =>
  changed.some(
    (file) =>
      file.startsWith('packages/') &&
      !UNPUBLISHED.some((dir) => file.startsWith(dir)) &&
      !file.endsWith('.md') &&
      !file.includes('/__tests__/') &&
      !file.endsWith('.test.ts'),
  );

export const hasChangeset = (changed: string[]): boolean =>
  changed.some(
    (file) => file.startsWith('.changeset/') && file.endsWith('.md') && !file.endsWith('README.md'),
  );

/**
 * The label that says this pull request needs no changelog entry.
 *
 * A dependency bump changes what the repository builds *with* and nothing about
 * what it publishes, so the gate has nothing to ask for — and a gate that asks
 * anyway teaches people to write empty changesets. Renovate applies this
 * label to every pull request it opens.
 */
export const SKIP_LABEL = 'skip-changeset';

/** The workflow hands labels over as one comma-separated string, or not at all. */
export const labelsOf = (value: string | undefined): string[] =>
  (value ?? '')
    .split(',')
    .map((label) => label.trim())
    .filter(Boolean);

export type Verdict = { exitCode: 0 | 1; message: string };

export const check = (changed: string[], labels: string[] = []): Verdict => {
  if (!touchesPackage(changed)) {
    return { exitCode: 0, message: 'check-changeset: no publishable change, nothing to require' };
  }
  if (labels.includes(SKIP_LABEL)) {
    return { exitCode: 0, message: `check-changeset: \`${SKIP_LABEL}\` set on this pull request` };
  }
  if (hasChangeset(changed)) {
    return { exitCode: 0, message: 'check-changeset: changeset present' };
  }
  return {
    exitCode: 1,
    message: [
      'check-changeset: this PR changes a published package but adds no changeset.',
      '',
      'Run `pnpm changeset` and commit the file it writes.',
      `If it publishes nothing — a dependency bump, say — label it \`${SKIP_LABEL}\`.`,
    ].join('\n'),
  };
};

/** Returns the process exit code rather than taking it, so tests can call it. */
export const main = (
  env: NodeJS.ProcessEnv = process.env,
  { diff = gitDiff }: { diff?: Differ } = {},
): number => {
  const base = env.BASE_SHA;
  const head = env.HEAD_SHA;

  if (!base || !head) {
    console.error('check-changeset: BASE_SHA and HEAD_SHA must be set');
    return 1;
  }

  const verdict = check(diff(base, head), labelsOf(env.PR_LABELS));
  if (verdict.exitCode === 0) console.log(verdict.message);
  else console.error(verdict.message);
  return verdict.exitCode;
};

/* v8 ignore start -- the entry shell; covered by the test that spawns this
   file, which reports no coverage back into this run. */
if (isEntry(import.meta.url)) {
  process.exit(main());
}
/* v8 ignore stop */
