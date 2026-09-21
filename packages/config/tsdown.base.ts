import type { UserConfig } from 'tsdown';

/**
 * The shared build defaults, so raising the floor is a single-file change
 * rather than a sweep across every package that misses one.
 *
 * ESM only: every supported Node can `require()` an ES module, so a CJS twin
 * would double the tarball to serve nobody.
 *
 * `fixedExtension` stays off: `.js` / `.d.ts`, matching the exports map, rather
 * than `.mjs` / `.d.mts`.
 *
 * Entries are passed per package as an object, never an array. An array makes
 * the output paths depend on an inferred common base dir, and a different
 * inference silently renames the files the exports map points at.
 */
export const baseBuildConfig = (overrides: UserConfig = {}): UserConfig => ({
  entry: { index: 'src/index.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  fixedExtension: false,
  dts: true,
  clean: true,
  ...overrides,
});
