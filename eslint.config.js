import { defineConfig, globalIgnores } from 'eslint/config'
import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default defineConfig(
  globalIgnores([
    '**/dist/',
    '**/coverage/',
    '**/.turbo/',
    // Local agent state; `.claude/worktrees/` can hold whole checkouts of this
    // repo, which would be linted against the wrong tsconfig.
    '**/.claude/',
    // Tool config lives outside the type-checked programs; linting it with
    // projectService would demand a tsconfig per config file.
    '**/*.config.{js,cjs,mjs,ts}',
    // Astro regenerates these type declarations on every build. They are not
    // ours to fix, and they fail rules the hand-written sources here pass.
    '**/.astro/',
  ]),
  js.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    extends: [tseslint.configs.strictTypeChecked, tseslint.configs.stylisticTypeChecked],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      // Libraries ship no console noise. Scripts and entrypoints opt out below.
      'no-console': 'error',
    },
  },
  {
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    // Repo tooling, where stdout is the output contract rather than a leak.
    files: ['packages/tooling/**'],
    rules: { 'no-console': 'off' },
  },
  {
    // Tests, and the fakes several suites share.
    files: ['**/*.test.{ts,tsx}', '**/*.fixtures.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      // A test may assert on a condition the types claim is impossible — that
      // is often the whole point of the test.
      '@typescript-eslint/no-unnecessary-condition': 'off',
      '@typescript-eslint/no-confusing-void-expression': 'off',
      '@typescript-eslint/no-empty-function': 'off',
      // `expect(spy).toHaveBeenCalledWith(…)` reads a method without calling
      // it, the one shape where this rule is always a false positive.
      '@typescript-eslint/unbound-method': 'off',
      '@typescript-eslint/require-await': 'off',
      'no-console': 'off',
    },
  },
)
