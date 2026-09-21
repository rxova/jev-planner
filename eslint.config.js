import { defineConfig, globalIgnores } from 'eslint/config';
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
  globalIgnores([
    '**/dist/',
    '**/coverage/',
    '**/.turbo/',
    // Astro writes these type declarations on every build.
    '**/.astro/',
    // Local agent state; `.claude/worktrees/` can hold whole checkouts of this repo.
    '**/.claude/',
    '**/*.config.{js,cjs,mjs,ts}',
  ]),
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
    },
  },
  {
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    // CommonJS by definition, so `require` is the only import form it has. The
    // changeset changelog wrapper has to be CJS: changesets loads it with `require()`.
    files: ['**/*.cjs'],
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
);
