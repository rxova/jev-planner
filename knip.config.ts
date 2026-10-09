import { baseKnipConfig } from "@rxova/repo-config/knip";

/**
 * Unused files, exports and dependencies, as a gate rather than a report.
 *
 * The `export` keyword is the point: an export nothing imports still has to be
 * kept working, still shows up in completions, and still reads as part of the
 * contract. Nothing else in this repository notices one.
 *
 * Entry points are inferred from each package's manifest, so the preset only
 * needs to hear about what inference cannot see. Its `apps/docs` default covers
 * `@rxova/brand`, which Starlight loads from a string in `customCss`.
 */
export default baseKnipConfig({
  // `rxova-repo-config check-exports` runs `attw` from a shell command, where knip cannot see it.
  // `@rxova/astro-ui` is reached only through the Starlight `customCss` string.
  ignoreDependencies: ["@arethetypeswrong/cli", "@rxova/astro-ui"],
});
