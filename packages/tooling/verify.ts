/**
 * The pre-push gate: the same ordered list CI runs, so a green push means a
 * green pipeline. Turbo replays whatever this commit did not touch, so a
 * re-push after a prose-only edit finishes in seconds.
 */
import { execSync } from 'node:child_process';
import { isEntry } from './entry.js';

export const STEPS: [name: string, command: string][] = [
  ['lint', 'pnpm lint'],
  ['format', 'pnpm format:check'],
  ['build', 'pnpm exec turbo run build'],
  ['typecheck', 'pnpm exec turbo run typecheck'],
  ['unit tests', 'pnpm exec turbo run test'],
  ['package exports', 'pnpm run check:exports'],
  ['pack smoke', 'pnpm run pack:smoke'],
  ['dependency versions', 'pnpm run sherif:check'],
  ['unused code', 'pnpm run knip:check'],
  // Kept after the two above: `pnpm dedupe --check` removes the modules
  // directory when CI is set, so a step after it runs without node_modules.
  ['dependency dedupe', 'pnpm exec turbo run //#dedupe:check'],
  ['audit', 'pnpm run audit:check'],
];

/** Runs one step. Injected so the sequencing can be tested without running it. */
export type Runner = (command: string) => void;

export const shell: Runner = (command) => {
  execSync(command, { stdio: 'inherit' });
};

/**
 * Stops at the first failure, because the second failure is usually the first
 * one wearing a different hat. Returns the process exit code.
 */
export const verify = (
  steps: [name: string, command: string][] = STEPS,
  { run = shell }: { run?: Runner } = {},
): number => {
  for (const [name, command] of steps) {
    process.stdout.write(`\nverify: ${name}\n`);
    try {
      run(command);
    } catch {
      process.stderr.write(`\nverify: ${name} failed\n`);
      return 1;
    }
  }

  process.stdout.write('\nverify: all checks passed\n');
  return 0;
};

/* v8 ignore start -- the entry shell: running it for real runs the entire
   pipeline, which is the thing this file exists to invoke. */
if (isEntry(import.meta.url)) {
  process.exit(verify());
}
/* v8 ignore stop */
