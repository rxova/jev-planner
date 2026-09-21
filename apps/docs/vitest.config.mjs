import { defineConfig } from 'vitest/config'

/**
 * Covers the agent-facing surfaces — the markdown normalizer, the page helpers,
 * the llms.txt builders and the build-time gate. Everything else about this site
 * is verified by the build itself: `astro check` types it, starlight-links-validator
 * walks its links, and check-md-routes reads the emitted dist.
 *
 * These four modules get unit tests because their failure mode is silent. A
 * mis-sectioned page or an unresolved link still produces a document that reads
 * as complete, and the reader who would notice is a model that cannot ask.
 *
 * brand-tokens is here for the same reason: a token it misreads still renders
 * a social card, just not a brand one. version-marker too: a wrong marker still
 * deploys, and only the post-release check would notice, ten minutes later.
 */
export default defineConfig({
  test: {
    include: ['scripts/**/*.test.mjs', 'src/**/*.test.mjs'],
    environment: 'node',
  },
})
