# Contributing

## Setup

Node 22.13 or newer, and pnpm through Corepack:

```sh
corepack enable
pnpm install
```

`pnpm install` also installs the git hooks.

## The loop

| Command           | What it does                                                     |
| ----------------- | ---------------------------------------------------------------- |
| `pnpm test`       | Unit tests with per-file coverage thresholds, every package      |
| `pnpm typecheck`  | `tsc` in every package, `astro check` in the docs                |
| `pnpm lint`       | ESLint over the whole tree                                       |
| `pnpm format`     | Prettier, writing                                                |
| `pnpm docs`       | The docs site on a local dev server                              |
| `pnpm run verify` | Everything CI runs, in CI's order — this is what `git push` runs |

Turbo caches every task, so a re-run over an unchanged tree is close to free.

## Hooks

- **pre-commit** — ESLint and Prettier over the staged files, then typecheck and tests.
- **commit-msg** — commitlint.
- **pre-push** — `pnpm run verify`. A push that only deletes refs skips it.

Please do not bypass them with `--no-verify`; CI runs the same checks.

## Commits and pull requests

[Conventional Commits](https://www.conventionalcommits.org/), checked by commitlint. Pull requests
are squash-merged, so the **PR title** becomes the commit subject and is checked too.

A change to a published package needs a changeset: run `pnpm changeset` and commit the file it
writes. A pull request that publishes nothing (a dependency bump, say) is labelled `skip-changeset`.
