import { defineConfig } from 'tsdown'
import { baseBuildConfig } from '@rxova/repo-config/tsdown'

// Node 20 rather than the preset's 22: jev-planner depends on this package,
// and its `engines` promises 20.19, so this one promises the same.
// Dual ESM + CJS with `.mjs` / `.cjs` and `.d.mts` / `.d.cts`, matching the
// exports map.
export default defineConfig(
  baseBuildConfig({
    target: 'node20',
    format: ['esm', 'cjs'],
    fixedExtension: true,
    entry: ['src/index.ts'],
  }),
)
