import { fileURLToPath } from 'node:url'

import { defineConfig } from 'astro/config'
import { unified } from '@astrojs/markdown-remark'
import starlight from '@astrojs/starlight'
import starlightLinksValidator from 'starlight-links-validator'
import sitemap from '@astrojs/sitemap'

import { rehypeMdLinks } from './src/lib/rehype-md-links.mjs'

/**
 * The defaults are production: GitHub Pages serves this repository's site at
 * `https://rxova.github.io/jev-planner/`, so a plain `pnpm build` is deployable
 * and `astro dev` serves under `/jev-planner/` too. docs.yml sets both anyway,
 * and these two are the one place to change if the site moves to a domain.
 *
 * Every emitted URL depends on `base`. An absolute reference that only resolves
 * at a domain root looks fine in a root build and 404s under `/jev-planner/`,
 * which is why the default is the real mount rather than `/`.
 */
const site = process.env.DOCS_URL ?? 'https://rxova.github.io'
const base = process.env.DOCS_BASE_URL ?? '/jev-planner/'

export default defineConfig({
  site,
  base,

  markdown: {
    // The content links between pages as `../guides/usage.md`, which is what
    // the `.md` twins need and what Astro emits verbatim into the HTML. One of
    // those two has to be rewritten, and rewriting the HTML is the side that
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
    // Emitted at the mount: GitHub Pages serves a project site under
    // `/jev-planner/`, so the file lands at <base>sitemap-index.xml and lists
    // only URLs beneath that prefix. No robots.txt can point at it — crawlers
    // only read one at the host root — so each page links it from <head>.
    sitemap({
      // The canonical HTML pages only. Every one of them also has a `.md` twin,
      // and llms.txt is built from the same enumeration, so listing those here
      // would hand a search engine three URLs per page and ask it to pick.
      filter: (page) => !page.endsWith('.md') && !/\/llms(?:-full)?\.txt$/.test(page),
    }),
    starlight({
      title: 'jev-planner',
      description:
        'Repository-aware implementation plans from two or more AIs — Codex and Claude by ' +
        'default — cross-reviewed and arbitrated by TypeSafe Jev.',
      social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/rxova/jev-planner' }],
      favicon: '/favicon.svg',
      customCss: ['./src/styles/theme.css'],
      sidebar: [
        { label: 'Learn', items: [{ autogenerate: { directory: 'learn' } }] },
        { label: 'Guides', items: [{ autogenerate: { directory: 'guides' } }] },
        { label: 'Reference', items: [{ autogenerate: { directory: 'reference' } }] },
      ],
      plugins: [
        // Every page here links to several others, so a link that rots is a
        // page somebody renamed. Worth failing the build for.
        starlightLinksValidator({ errorOnRelativeLinks: false }),
      ],
    }),
  ],
})
