/**
 * The gate: what the pre-push hook runs, and what CI runs, in the same order.
 * CI is one job that calls this, so a green push means a green pipeline and
 * there is no second list to drift out of step with the first.
 *
 * Cheapest first, so the common failures cost seconds: a lockfile that needs a
 * dedupe or a file that needs a format is found before a minute of tests.
 * Turbo replays whatever this commit did not touch.
 *
 * `audit` is deliberately absent: its verdict changes with the advisory
 * database, not with this tree, so an overnight CVE would start failing every
 * push for code nobody changed. CI runs it in its own job, where that call
 * belongs.
 *
 * The docs site is excluded from `build` for a different reason: docs.yml
 * builds it for jev-planner.com, runs its browser tests against that dist and
 * deploys it. Rendering it again here would add an Astro build to every push
 * to re-prove what that job proves on the output that ships. `typecheck` and `test`
 * still cover it.
 *
 * CI runs these steps as separate parallel jobs rather than calling this script,
 * so a failure names itself instead of arriving as "verify failed" — the repo is
 * public and its Actions minutes are free, which is what pays for the split.
 * The lists are held together by `verify.test.ts`.
 */
import { execSync } from 'node:child_process'
import { isEntry } from '../entry/entry.js'
import type { Runner } from './verify.types.js'

export const STEPS: [name: string, command: string][] = [
  // One version of each dependency across the workspace. Two packages on two
  // minors of the same library typecheck fine and then disagree at runtime.
  ['dependency versions', 'pnpm run sherif:check'],
  // Unused files, exports and dependencies. The only check here that notices
  // an export nothing imports.
  ['unused files, exports and dependencies', 'pnpm run knip:check'],
  // Both of the above come first on purpose: `pnpm dedupe --check` removes the
  // modules directory when CI is set, so a step placed after it on a cache miss
  // runs without node_modules and fails looking for its own binary.
  ['dependency dedupe', 'pnpm exec turbo run //#dedupe:check'],
  ['format', 'pnpm run format:check'],
  ['lint', 'pnpm run lint'],
  ['llms.txt', 'pnpm run check:llms'],
  ['typecheck', 'pnpm exec turbo run typecheck'],
  ['unit tests', 'pnpm exec turbo run test'],
  ['build', "pnpm exec turbo run build --filter='!@repo/docs'"],
  ['package exports', 'pnpm run check:exports'],
]

export const shell: Runner = (command) => {
  execSync(command, { stdio: 'inherit' })
}

/**
 * Stops at the first failure, because the second failure is usually the first
 * one wearing a different hat. Returns the process exit code.
 */
export const verify = (
  steps: [name: string, command: string][] = STEPS,
  { run = shell }: { run?: Runner } = {},
): number => {
  for (const [name, command] of steps) {
    process.stdout.write(`\nverify: ${name}\n`)
    try {
      run(command)
    } catch {
      process.stderr.write(`\nverify: ${name} failed\n`)
      return 1
    }
  }

  process.stdout.write('\nverify: all checks passed\n')
  return 0
}

/* v8 ignore start -- the entry shell: running it for real runs the entire
   pipeline, which is the thing this file exists to invoke. */
if (isEntry(import.meta.url)) {
  process.exit(verify())
}
/* v8 ignore stop */
