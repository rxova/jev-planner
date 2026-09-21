import { fileURLToPath } from 'node:url'

import { defineConfig } from 'astro/config'
import { unified } from '@astrojs/markdown-remark'
import starlight from '@astrojs/starlight'
import starlightLinksValidator from 'starlight-links-validator'
import sitemap from '@astrojs/sitemap'
import { sharedStarlightConfig } from '@rxova/brand'

import { rehypeMdLinks } from './src/lib/rehype-md-links.mjs'

/**
 * The defaults keep a standalone build working — `pnpm --filter @repo/docs dev`
 * serves the site at the root. docs.yml overrides both so the dist is built for
 * the path rxova.org actually mounts it at, `/packages/ts-extended-errors/`. An
 * absolute reference that only resolves at a domain root is invisible in a root
 * build and breaks the moment it is mounted, which is why the published build
 * never uses these values.
 */
const site = process.env.DOCS_URL ?? 'https://rxova.org'
const base = process.env.DOCS_BASE_URL ?? '/'

export default defineConfig({
  site,
  base,

  markdown: {
    // The content links between pages as `../guides/cause-chains.md`, which is
    // what the `.md` twins need and what Astro emits verbatim into the HTML. One
    // of those two has to be rewritten, and rewriting the HTML is the side that
    // keeps the source readable as files.
    processor: unified({
      rehypePlugins: [
        [
          rehypeMdLinks,
          { base, docsRoot: fileURLToPath(new URL('src/content/docs', import.meta.url)) },
        ],
      ],
    }),
  },

  integrations: [
    // Nothing else here enumerates these pages for a crawler, and the questions
    // these docs answer — "extend Error in TypeScript", "instanceof false after
    // subclassing", "send an error through JSON" — are ones people type into a
    // search engine rather than arrive at from a link.
    //
    // Emitted at the mount rather than the domain root: under the aggregator the
    // file lands at <base>sitemap-index.xml and lists only URLs beneath that
    // prefix, which is the scope a sitemap at a subpath is allowed to claim.
    // rxova.org's root robots.txt is what points at it.
    sitemap({
      // The canonical HTML pages only. Every one of them also has a `.md` twin,
      // and llms.txt is built from the same enumeration, so listing those here
      // would hand a search engine three URLs per page and ask it to pick.
      filter: (page) => !page.endsWith('.md') && !/\/llms(?:-full)?\.txt$/.test(page),
    }),
    starlight({
      ...sharedStarlightConfig({
        // `@rxova/brand` resolves this id against its own PROJECTS list — the
        // one the docs switcher, the footer and the social card are built from
        // — and throws for an id it does not know. So this build needs
        // @rxova/brand >= 0.14.0, the release that adds ts-extended-errors to
        // that list.
        project: 'ts-extended-errors',
        // These docs ship as a page component: rxova.org composes each rendered
        // body into its own header and footer, so this build must not draw the
        // umbrella footer itself.
        pageComponent: true,
        sidebar: [
          { label: 'Learn', items: [{ autogenerate: { directory: 'learn' } }] },
          { label: 'Guides', items: [{ autogenerate: { directory: 'guides' } }] },
          { label: 'Reference', items: [{ autogenerate: { directory: 'reference' } }] },
          {
            label: 'Under the hood',
            items: [{ autogenerate: { directory: 'under-the-hood' } }],
          },
        ],
      }),
      // Overrides the shared default of '/favicon.svg'. There is no vector mark
      // for this project, so the tab icon is the rxova mark as a PNG, copied
      // from @rxova/brand's asset. Starlight resolves `favicon` against this
      // site's own `public/`, so it cannot come from the package.
      favicon: '/favicon.png',
      plugins: [
        // Every page here links to several others, so a link that rots is a
        // page somebody renamed. Worth failing the build for.
        starlightLinksValidator({ errorOnRelativeLinks: false }),
      ],
    }),
  ],
})
