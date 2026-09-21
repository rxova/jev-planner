import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      // `text` for a human reading CI logs, `lcov` for the coverage service.
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts'],
      // Per file, so one well-tested module cannot carry an untested one.
      // Raise these as the suite improves; never lower one to get a build green.
      thresholds: {
        perFile: true,
        statements: 95,
        branches: 95,
        functions: 95,
        lines: 95,
      },
    },
  },
});
