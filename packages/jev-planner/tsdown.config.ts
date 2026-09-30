import { defineConfig } from "tsdown";
import { baseBuildConfig } from "@rxova/repo-config/tsdown";

// Node 20 rather than the preset's 22: this package is published, and its
// `engines` promises 20.19. `bin.ts` is the executable; `index.ts` is the
// library, for callers that drive the planner with their own agents.
//
// `@rxova/planner-core` is private, so it is a dev dependency and bundled in,
// types too, and with it the `@rxova/ts-utils` helpers it inlines. `onlyImport` fails the build if the output still imports it, or
// anything else that is not in `dependencies`.
export default defineConfig(
  baseBuildConfig({
    target: "node20",
    // Dual ESM + CJS with `.mjs` / `.cjs` and `.d.mts` / `.d.cts`, matching
    // the exports map.
    format: ["esm", "cjs"],
    fixedExtension: true,
    entry: ["src/index.ts", "src/bin.ts"],
    deps: { onlyImport: ["@typesafe-ai/sdk"] },
  }),
);
