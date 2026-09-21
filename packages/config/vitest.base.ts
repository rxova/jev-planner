import { defineConfig, type ViteUserConfig } from 'vitest/config'

/**
 * The one home of the coverage thresholds.
 *
 * Per file, so one thinly covered module cannot hide behind a well-covered one
 * in the aggregate. Raise them as the suites improve; never lower one to get a
 * build green.
 */
export const COVERAGE_THRESHOLDS = {
  perFile: true,
  statements: 95,
  branches: 95,
  functions: 95,
  lines: 95,
} as const

/**
 * `index.ts` is a re-export barrel and `types.ts` is types only; neither has
 * executable lines worth a threshold. Logic that lands in either one is logic
 * the thresholds cannot see, so keep them to re-exports and types.
 */
const BASE_EXCLUSIONS = ['src/**/__tests__/**', 'src/index.ts', 'src/types.ts'] as const

export interface BaseVitestOptions {
  /** Vitest `environment`. `jsdom` needs `jsdom` installed in the package. */
  readonly environment?: 'node' | 'jsdom'
  /** Test discovery globs. Defaults to `src/**\/__tests__/**`. */
  readonly include?: readonly string[]
  /** Extra coverage exclusions. Each one needs a reason at its call site. */
  readonly exclude?: readonly string[]
}

/**
 * A package's Vitest config, from the shared preset. Every `vitest.config.ts`
 * is expected to be a one-liner over this, so that raising the bar is a
 * single-file change rather than a sweep that misses a package.
 */
export function baseVitestConfig({
  environment = 'node',
  include = ['src/**/__tests__/**/*.test.ts', 'src/**/__tests__/**/*.test.tsx'],
  exclude = [],
}: BaseVitestOptions = {}): ViteUserConfig {
  return defineConfig({
    test: {
      environment,
      include: [...include],
      coverage: {
        provider: 'v8',
        // `text` for the CI log, `html` for the uploaded artifact.
        reporter: ['text', 'html', 'json-summary'],
        include: ['src/**/*.{ts,tsx}'],
        exclude: [...BASE_EXCLUSIONS, ...exclude],
        thresholds: { ...COVERAGE_THRESHOLDS },
      },
    },
  })
}
