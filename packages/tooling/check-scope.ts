/**
 * Decides whether an event actually changed anything a test could fail on, and
 * reports it as the `code-changed` output the rest of the workflow gates on.
 *
 * One kind of commit reaches CI without moving the tree in any meaningful way:
 * the release commit. `changeset version` bumps a version field, writes a
 * changelog and consumes the changeset files. The source tree is otherwise
 * byte-identical to a parent CI already proved green, so re-running the whole
 * matrix re-derives a verdict that commit already carries. That inheritance is
 * only sound because a push to main is never cancelled, so the parent's
 * verdict is one that actually finished.
 *
 * The release commit is recognised by its file set, never by its branch name or
 * its subject line, both of which anyone can write. A `package.json` counts only
 * when the edited lines are its version and nothing else, so a commit that
 * slipped a dependency in beside the bump still runs the full suite.
 *
 * Every uncertain case resolves to running everything. Skipping is the
 * dangerous answer, so it is only ever reached deliberately.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { isEntry } from './entry.js';

/** The only thing this module needs a repository for. Injected for tests. */
export type Git = (...args: string[]) => string;

export const git: Git = (...args) =>
  execFileSync('git', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });

/** True when the only edited lines in a file are its `"version":` line. */
export const versionBumpOnly = (
  file: string,
  range: { base: string; head: string },
  run: Git,
): boolean => {
  const edits = run('diff', '--unified=0', `${range.base}...${range.head}`, '--', file)
    .split('\n')
    .filter((line) => /^[+-]/.test(line) && !/^(\+\+\+|---)/.test(line));
  return edits.length > 0 && edits.every((line) => /^[+-]\s*"version":\s*"[^"]*",?\s*$/.test(line));
};

/** True when a path only ever carries release bookkeeping. */
export const isReleaseMetadata = (file: string): boolean =>
  (file.startsWith('.changeset/') && file.endsWith('.md')) ||
  file === 'CHANGELOG.md' ||
  file.endsWith('/CHANGELOG.md');

export type Scope = { codeChanged: boolean; reason: string };

export const decideScope = (
  base: string | undefined,
  head: string | undefined,
  run: Git = git,
): Scope => {
  // An initial push reports an all-zero `before`, and a force-push can report a
  // commit that is no longer reachable. Neither is a licence to skip.
  if (!base || !head || /^0+$/.test(base)) {
    return { codeChanged: true, reason: 'no usable commit range' };
  }

  let changed: string[];
  try {
    changed = run('diff', '--name-only', `${base}...${head}`).split('\n').filter(Boolean);
  } catch {
    return { codeChanged: true, reason: 'could not diff the range' };
  }

  if (changed.length === 0) return { codeChanged: true, reason: 'empty diff' };

  const releaseOnly = changed.every((file) => {
    if (isReleaseMetadata(file)) return true;
    if (file === 'package.json' || file.endsWith('/package.json')) {
      return versionBumpOnly(file, { base, head }, run);
    }
    return false;
  });

  return releaseOnly
    ? {
        codeChanged: false,
        reason: `release commit — ${changed.length} file(s), version and changelog only`,
      }
    : { codeChanged: true, reason: `${changed.length} file(s) changed` };
};

/** Returns the process exit code rather than taking it, so tests can call it. */
export const main = (
  env: NodeJS.ProcessEnv = process.env,
  { run = git }: { run?: Git } = {},
): number => {
  const verdict = decideScope(env.BASE_SHA, env.HEAD_SHA, run);

  console.log(`check-scope: ${verdict.reason}`);
  console.log(`check-scope: code-changed=${verdict.codeChanged}`);

  if (env.GITHUB_OUTPUT) {
    appendFileSync(env.GITHUB_OUTPUT, `code-changed=${verdict.codeChanged}\n`);
  }
  return 0;
};

/* v8 ignore start -- the entry shell; covered by the test that spawns this
   file, which reports no coverage back into this run. */
if (isEntry(import.meta.url)) {
  process.exit(main());
}
/* v8 ignore stop */
