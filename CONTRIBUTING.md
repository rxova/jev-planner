# Contributing

Bug reports, documentation fixes, new agents, and small improvements are welcome.

## Before you start

- **Bug:** open an issue with the smallest reproduction that shows the problem, what happened, and
  what you expected.
- **New behavior or public API:** open an issue first. The public surface is deliberately small, and
  agreeing on the shape saves everyone a rewrite.
- **Small fix:** typo, broken link, or obvious mistake can go straight to a pull request.
- **Security problem:** do not open a public issue. Follow [SECURITY.md](SECURITY.md).

Please follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Development setup

This is a pnpm + Turborepo workspace. Development needs Node.js 22.13 or newer. The published
`jev-planner` package supports Node.js 20.19 and newer; the pack smoke test proves that separately.

```sh
corepack enable
pnpm install
```

Useful tools:

```sh
pnpm test                         # all unit tests; library coverage enforced per file
pnpm --filter jev-planner test    # library only
pnpm typecheck
pnpm lint
pnpm run format:check
pnpm build                        # workspace packages, dual ESM + CJS
```

To run a single test file:

```sh
pnpm --filter @rxova/planner-core exec vitest run src/providers/providers.test.ts
```

Before asking for review, run the full verification gate:

```sh
pnpm run verify
```

`verify` runs the pre-push checks in CI order. It intentionally leaves the registry audit and
package smoke test to CI.

## Documentation site

`apps/docs` is Astro + Starlight. It powers [jev-planner.com](https://jev-planner.com/) and deploys
to GitHub Pages from `main`.

```sh
pnpm --filter @repo/docs dev       # local site at the root
pnpm --filter @repo/docs build     # site + links + .md twins + size budgets
pnpm --filter @repo/docs test      # docs unit tests
pnpm --filter @repo/docs test:e2e  # Playwright + axe; build first
pnpm --filter @repo/docs og        # regenerate social card
```

Every docs page also ships as raw Markdown at `<route>.md`. The same page list builds `llms.txt`
and `llms-full.txt`. Do not hand-edit emitted files in `dist/`.

The root README is deliberately compact and direct. Package reference and site docs provide the
detail. When product facts change, update every affected audience in the same pull request.

## Tests

- Each feature has a folder: `src/<feature>/<feature>.ts` for the code, `<feature>.test.ts` for
  its tests, `<feature>.types.ts` for its types.
- Coverage is at least 95% per file. Raise thresholds; never lower them.
- Never skip, delete, or weaken a test to make a change pass.
- Never hardcode an expected answer or switch off a check.
- ESLint runs `strictTypeChecked`. Fix finding. If a disable is truly necessary, scope it to one line
  and explain why.

## Adding an AI

Providers live in one registry: `PROVIDERS` in `packages/core/src/providers/providers.ts`. CLI flags,
help, doctor checks, prompts, and Jev choices all grow from that list.

- OpenAI-compatible chat API: add one `openAICompatibleProvider(...)` call.
- Read-only, non-interactive agent CLI: add one `cliProvider(...)` call.
- CLI with JSON event output: add `events`, so `--verbose` can show its work and extract its answer.

Also add the provider to the tables in the root and package READMEs. Test unique IDs, secrets,
doctor behavior, arguments, event parsing, and the unhappy path.

## Changing the public API

A public API change ships together with:

1. Code and tests.
2. TSDoc.
3. The matching section in the package's `README.md` (`packages/core` or `packages/jev-planner`).
4. The matching page under `apps/docs/src/content/docs/`.
5. The API table, examples, or cautions in that package's `llms.txt`.
6. A changeset.

`pnpm run check:llms` compares package exports with the `llms.txt` API table in both directions.
Rename one without the other and the check fails.

## Commits

Use [Conventional Commits](https://www.conventionalcommits.org), subject line only.

Allowed types: `build`, `chore`, `ci`, `docs`, `feat`, `fix`, `perf`, `refactor`, `rename`, `revert`,
`style`, `test`.

Pull requests are squash-merged, so PR title becomes commit on `main`. Make title valid. Never use
`--no-verify`.

## Changesets

Any pull request that changes the published package needs a changeset:

```sh
pnpm changeset
```

Before 1.0, a breaking change is a minor. A pull request that touches the package but publishes
nothing—like a dev dependency bump—gets the `skip-changeset` label instead.

## Releases

`release.yml` opens a `chore: version packages` pull request from pending changesets. Merging that
pull request publishes `jev-planner` through npm trusted publishing, with provenance, and tags the
release. It runs only while repository variable `RELEASE_ENABLED` is `true`.

Nothing is published from a local machine.
