# Contributing

Thanks for taking the time. Bug reports, documentation fixes and small
improvements are all welcome.

## Before you start

- **Bugs**: open an issue with a reduced reproduction — the smallest snippet
  that shows the wrong result, plus what you expected. For a serialization
  problem, include the object `serializeError` produced and the `classes` you
  passed to `deserializeError`.
- **New exports or changed behaviour**: open an issue first. The public surface
  is deliberately small, and every export has to be documented in four places
  (see [Changing the public API](#changing-the-public-api)), so it is worth
  agreeing on the shape before the work.
- **Small fixes**: typos, broken links and obvious mistakes can go straight to a
  pull request.

Security issues do not go in an issue — see [SECURITY.md](SECURITY.md).

## Development setup

A pnpm workspace driven by Turborepo. The toolchain needs Node.js 22.13 or newer
(pnpm 11 requires it); the published package supports Node.js 20.19 and up,
which CI verifies by packing the tarball and running it under Node 20.

```bash
corepack enable
pnpm install
```

```bash
pnpm test                                    # unit tests, coverage enforced per file
pnpm --filter ts-extended-errors test # the library alone
pnpm typecheck
pnpm lint
pnpm run format:check
pnpm build                                   # the library's dist
```

`pnpm run verify` runs every check in one ordered list and is what the pre-push
hook calls. Run it before asking for review; CI runs the same checks as separate
jobs, so a green verify means a green pipeline.

A single test file:

```bash
pnpm --filter ts-extended-errors exec vitest run src/__tests__/serialize.test.ts
```

## The docs site

`apps/docs` is an Astro + Starlight site, published as part of
[rxova.org](https://rxova.org/packages/ts-extended-errors/) rather than from this
repository — `docs.yml` builds the dist and hands it to the aggregator.

```bash
pnpm --filter @repo/docs dev    # localhost, served at the root
pnpm --filter @repo/docs build  # build, validate links, check the .md twins
pnpm --filter @repo/docs test   # the markdown normalizer and the llms.txt builders
```

Every page is also served as raw markdown at `<route>.md`, and `llms.txt` /
`llms-full.txt` are generated from the same page enumeration. `scripts/check-md-routes.mjs`
runs as part of the build and fails it if a page grows markup the normalizer does
not handle, if a `.md` link lands nowhere, or if `llms.txt` outgrows its budget.

## Tests

- Source in `src/`, tests in `src/**/__tests__/`.
- Coverage is enforced at 95% per file, from `packages/config`. Thresholds may be
  raised, never lowered.
- Never skip, delete or weaken a test to make a change pass, and never make one
  pass by hardcoding the answer it was checking.

## Commits

[Conventional Commits](https://www.conventionalcommits.org), subject line only.
Allowed types: `build`, `chore`, `ci`, `docs`, `feat`, `fix`, `perf`, `refactor`,
`rename`, `revert`, `style`, `test`. There is no length limit.

Commitlint checks the branch commits, the pushed commit, and the pull request
title — pull requests are squash-merged, so the title becomes the commit on
`main` and has to be valid on its own.

Never `--no-verify`.

## Changesets

Any pull request that changes the published package needs a changeset:

```bash
pnpm changeset
```

CI checks for one. A pull request that touches the package but publishes nothing
— a dev dependency bump, say — is labelled `skip-changeset` instead. Before 1.0,
a breaking change is a minor.

## Adding a new AI

One entry in `PROVIDERS`, in `packages/jev-planner/src/providers.ts`. The CLI flags, `--help`,
`doctor`, the prompts and Jev's choices are all built from that list, so nothing else changes:

- An OpenAI-compatible chat API: one `openAICompatibleProvider({ id, label, baseUrl, apiKeyEnv, model })`.
- An agent CLI that answers once, non-interactively and read-only, with the prompt on stdin: one
  `cliProvider({ id, label, command, args, auth? })`.

Add the agent to the table under "Agents" in the package README too. `providers.test.ts` checks the
ids are unique and every API key is declared as a secret; a new adapter kind needs its own tests.

## Changing the public API

An export is described in four places, and they are checked against each other.
A change to one ships with the rest, in the same pull request:

1. The code and its tests.
2. The TSDoc on the export.
3. The section for it in `packages/ts-extended-errors/README.md`, and the page
   for it under `apps/docs/src/content/docs/`.
4. The `## API` table in `packages/ts-extended-errors/llms.txt`.

`pnpm run check:llms` compares that table against `src/index.ts` in both
directions, so a renamed export fails until the table is updated.

## Releases

`release.yml` opens a `chore: version packages` pull request from the pending
changesets. Merging it publishes `ts-extended-errors` to npm through
trusted publishing, with provenance and no stored token, and tags the release. It runs only while
the repository variable `RELEASE_ENABLED` is `true`, and nothing is published
from a local machine.
