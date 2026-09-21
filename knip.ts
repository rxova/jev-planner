import type { KnipConfig } from 'knip';

/**
 * Unused files, exports and dependencies, as a gate rather than a report.
 *
 * The `export` keyword is the point: an export nothing imports still has to be
 * kept working, still shows up in completions, and still reads as part of the
 * contract. Nothing else in this repository notices one.
 *
 * Entry points are inferred from each package's manifest, so what follows is
 * only the things inference cannot know — every one of them a place where a
 * file is reached by something other than a TypeScript import.
 */
export default {
  // Advice nobody has to act on is advice that stops being read.
  treatConfigHintsAsErrors: true,
  workspaces: {
    'packages/tooling': {
      // Repo scripts, invoked by name from package.json and CI, never imported.
      entry: ['*.ts'],
    },
  },
} satisfies KnipConfig;
