# Agent guide

pnpm + Turborepo monorepo. Node >= 22.13. TypeScript everywhere, ESM only.

## Layout

- `packages/*` — published npm packages (each one needs a changeset when it changes).
- `packages/tooling` — repo scripts (verify, changeset gate, pack smoke). Never published.
- `packages/config` — the shared tsdown preset every package builds with. Never published.
- `apps/docs` — Astro Starlight site, deployed to GitHub Pages.

## Commands

- `pnpm run verify` — the full gate, same order as CI. Run it before saying work is done.
- `pnpm test` / `pnpm typecheck` / `pnpm lint` / `pnpm format` — the pieces.
- `pnpm --filter <package> test` — one package.
- `pnpm changeset` — record a change to a published package.

## Rules

- Tests live next to the code (`src/foo.test.ts`). Coverage is 95% per file; raise thresholds,
  never lower them.
- Never skip, delete or weaken a test to make a change pass.
- Conventional Commits; subject line only. Never `--no-verify`.
- No new runtime dependency in a published package without saying why.
