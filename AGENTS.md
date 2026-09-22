# Agent guide

pnpm + Turborepo monorepo. Node >= 22.13 to develop. TypeScript everywhere.

## Layout

- `packages/jev-planner` — the library and CLI, published to npm as
  `jev-planner`. It supports Node >= 20.19, so it builds for Node 20, not the
  preset's 22.
- `packages/core` — `@rxova/planner-core`: the planner, the providers and the shared CLI (`main`),
  parametrized by a `PlannerProgram`. jev-planner is its program, judge and `bin`. Also built for
  Node 20.
- `packages/*` — workspace packages, built dual ESM + CJS with tsdown.
- `packages/config` — the shared vitest and tsdown presets. Coverage thresholds live here only.
- `packages/tooling` — repo scripts (`verify`, `pack-smoke`, `check-llms`, `check-changeset`).
- `.changeset` — pending release notes. A change to the library adds one (`pnpm changeset`); CI
  checks. A pull request that publishes nothing (a dev dependency bump) is labelled `skip-changeset`.
- `apps/docs` — the landing page and documentation (Astro + Starlight), deployed to GitHub Pages
  at https://jev-planner.com by `docs.yml`, which builds it, runs its Playwright tests
  (`pnpm --filter @repo/docs test:e2e`, after a build) and deploys it. Excluded from `verify`'s
  build step for that reason.

## Commands

- `pnpm run verify` — the pre-push gate, in CI's order. Every check CI runs except two:
  `audit:check`, left to CI on purpose so a newly disclosed advisory cannot block an unrelated
  push (`verify.test.ts` pins that omission), and `pack:smoke`. Run it before saying work is done.
- `pnpm test` / `pnpm typecheck` / `pnpm lint` / `pnpm format` — the pieces.
- `pnpm --filter <package> test` — one package.
- `pnpm run check:llms` — each `llms.txt` against the package exports; part of `verify`.
- `pnpm --filter @repo/docs build` — the docs site, plus link validation and the `.md`-twin check.
- `pnpm --filter @repo/docs dev` — the docs site at localhost, served at the root.

## Rules

- Source in `src/`, tests in `src/**/__tests__/`. `src/index.ts` re-exports only, `src/types.ts`
  holds types only — both are excluded from coverage, so logic there is logic nobody measures.
- Coverage is 95% per file; raise thresholds, never lower them.
- Never skip, delete or weaken a test to make a change pass.
- Never make a test pass by hardcoding its expected answer or switching a check off.
- ESLint runs `strictTypeChecked`. Fix the finding rather than disabling the rule; if a disable is
  truly needed, scope it to one line and say why.
- Conventional Commits; subject line only. Never `--no-verify`.
- Keep the root `README.md` compact, direct, and readable. Package reference docs, site docs, and
  agent instructions carry the details. When a product fact changes, update every affected audience
  in the same change.

## Agent-facing files

| File                             | Read by                                                           | Kept in step by                                                                                       |
| -------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `README.md`                      | People arriving at the repository                                 | Nothing automatic: keep its claims aligned with the package README and docs                           |
| `CONTRIBUTING.md`                | People changing the repository                                    | Nothing automatic: keep commands aligned with `package.json`                                          |
| `packages/jev-planner/llms.txt`  | An agent using the library, from `node_modules`                   | `check-llms`: the `## API` table matches `src/index.ts` both ways; `pack-smoke`: it is in the tarball |
| `packages/jev-planner/README.md` | People, and agents that follow the `llms.txt` link                | Nothing automatic: type-check and run an example after changing it                                    |
| `packages/core/llms.txt`         | An agent using the planner core, from `node_modules`              | `check-llms` and `pack-smoke`, as for jev-planner's                                                   |
| `llms.txt`                       | An agent that reaches the repository rather than the package      | `check-llms`: it links every published package's `llms.txt`                                           |
| `apps/docs/src/content/docs/**`  | People and agents on jev-planner.com; every page has a `.md` twin | The docs build: `starlight-links-validator`, then `check-md-routes.mjs` over the emitted dist         |
| `apps/docs/src/lib/llms.mjs`     | An agent fetching the site's `llms.txt` or `llms-full.txt`        | Its own unit tests, and the size budgets in `check-md-routes.mjs`                                     |
| `AGENTS.md`                      | An agent editing this repository                                  | —                                                                                                     |

`llms.txt` is hand-written. A renamed export fails `check-llms` until the table is updated, so
rename the export and update the table in the same commit.

## Change these together

A change to the public API ships in one pull request with:

- the code and its tests
- the TSDoc
- the README section for the export, and the root README when its product summary changes
- the page for it under `apps/docs/src/content/docs/`
- the `## API` table, examples or cautions in the package's `llms.txt`
- a changeset
