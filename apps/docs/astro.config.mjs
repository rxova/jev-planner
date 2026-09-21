import { fileURLToPath } from 'node:url'

import { defineConfig } from 'astro/config'
import { unified } from '@astrojs/markdown-remark'
import starlight from '@astrojs/starlight'
import starlightLinksValidator from 'starlight-links-validator'
import sitemap from '@astrojs/sitemap'

import { rehypeMdLinks } from './src/lib/rehype-md-links.mjs'

/**
 * The defaults are production: GitHub Pages serves this repository's site at
 * the custom domain `https://jev-planner.com/`, so a plain `pnpm build` is
 * deployable. docs.yml sets both anyway, and these two are the one place to
 * change if the site moves.
 *
 * Every emitted URL still goes through `base`. Written that way, the site keeps
 * working if it is ever served from a sub-path again — `rxova.github.io/jev-planner/`
 * is what Pages falls back to without the domain — and check-site-build rejects
 * a root-relative link that skips it.
 */
const site = process.env.DOCS_URL ?? 'https://jev-planner.com'
const base = process.env.DOCS_BASE_URL ?? '/'

/**
 * The social card, absolute: a crawler resolves nothing against the page it
 * found the tag on. Rendered by scripts/make-og.mjs into public/.
 */
const ogImage = new URL(`${base.replace(/\/?$/, '/')}og.png`, site).href

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
    // Emitted at <base>sitemap-index.xml and linked from every page's <head>,
    // which is where Starlight looks for it. At the domain root a robots.txt
    // could point at it too; the <head> link works at any base.
    sitemap({
      // The canonical HTML pages only. Every one of them also has a `.md` twin,
      // and llms.txt is built from the same enumeration, so listing those here
      // would hand a search engine three URLs per page and ask it to pick.
      filter: (page) => !page.endsWith('.md') && !/\/llms(?:-full)?\.txt$/.test(page),
    }),
    starlight({
      title: 'jev-planner',
      logo: {
        dark: './src/assets/logo-dark.svg',
        light: './src/assets/logo-light.svg',
        // The visually hidden title below supplies the link's accessible name.
        alt: '',
        replacesTitle: true,
      },
      description:
        'Repository-aware implementation plans from two or more AIs — Codex and Claude by ' +
        'default — cross-reviewed and arbitrated by TypeSafe Jev.',
      social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/rxova/jev-planner' }],
      favicon: '/favicon.svg',
      components: { Head: './src/components/overrides/Head.astro' },
      // Starlight already writes the canonical link, og:url, og:title,
      // og:description, twitter:card and the sitemap link. It has no image.
      head: [
        { tag: 'meta', attrs: { property: 'og:image', content: ogImage } },
        { tag: 'meta', attrs: { property: 'og:image:width', content: '1200' } },
        { tag: 'meta', attrs: { property: 'og:image:height', content: '630' } },
        {
          tag: 'meta',
          attrs: {
            property: 'og:image:alt',
            content: 'jev-planner: implementation plans from AIs that review each other.',
          },
        },
      ],
      // The brand face, then the brand's Starlight mapping; theme.css adjusts it.
      customCss: ['./src/styles/fonts.css', '@rxova/brand/starlight.css', './src/styles/theme.css'],
      // Wrap long lines instead of scrolling them. A scrolling code block is a
      // region keyboard users cannot reach (axe: scrollable-region-focusable),
      // and on a phone most commands on these pages are wider than the screen.
      expressiveCode: { defaultProps: { wrap: true } },
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
