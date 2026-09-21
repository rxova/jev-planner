import type { UserConfig } from 'tsdown'

/**
 * Dual ESM + CJS build for every package.
 *
 * Whatever a consumer's toolchain needs, the dual format also gives
 * `check:exports` two independent resolutions to prove. An
 * exports map that resolves under a bundler but not under plain Node is the
 * classic silent breakage, and a `require()` path is the cheapest way to catch
 * it. Drop `cjs` in a package that will only ever be imported.
 */
export const baseBuildConfig = (overrides: UserConfig = {}): UserConfig => ({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  platform: 'node',
  target: 'node22',
  // `.mjs` / `.cjs` and `.d.mts` / `.d.cts`, matching the exports maps.
  fixedExtension: true,
  dts: true,
  clean: true,
  ...overrides,
})
