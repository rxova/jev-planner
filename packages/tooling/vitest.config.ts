import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['*.test.ts'],
    coverage: {
      provider: 'v8',
      // `text` for a human reading CI logs, `lcov` for the coverage service.
      reporter: ['text', 'lcov'],
      // Every script in the package, with no opt-out: each one exports its
      // work as functions and runs it only behind an entry check, so there is
      // nothing here that cannot be tested. A new file is covered by the glob
      // the moment it is added, and held to the same bar.
      include: ['*.ts'],
      exclude: ['*.test.ts', '*.config.ts'],
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
