# Changesets

A pull request that changes a published package adds one of these: run `pnpm changeset`, pick the
packages and the bump, and commit the file it writes. CI's `changeset present` job asks for it; a
pull request that publishes nothing (a dependency bump, say) is labelled `skip-changeset` instead.

On merge, the Release workflow gathers them into a `chore: version packages` pull request, and
merging that one publishes to npm.
