<!--
The title becomes the squash subject, so it has to be a valid Conventional
Commit on its own. Commitlint checks it.
-->

## What this changes

<!-- One or two sentences. What behaviour is different after this merges? -->

## Why

<!-- The problem this solves. Link the issue if there is one. -->

## How it was verified

- [ ] `pnpm run verify`
- [ ] New or updated tests cover the change

## Checklist

- [ ] No new runtime dependency in `packages/ts-extended-errors`
- [ ] Changeset added (`pnpm changeset`), or the change does not touch the published package
- [ ] For a public API change: TSDoc, the package README, the docs page and the `llms.txt` API table all updated
