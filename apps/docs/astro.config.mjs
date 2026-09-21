import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import starlightLinksValidator from 'starlight-links-validator';

/**
 * The defaults keep a standalone build working — `pnpm docs` serves the site at
 * the root. The Docs workflow overrides both so the dist is built for the path
 * GitHub Pages serves it at, `/<repository>/`. Starlight writes the sitemap on
 * its own whenever `site` is set.
 */
const site = process.env.DOCS_URL ?? 'https://rxova.github.io';
const base = process.env.DOCS_BASE_URL ?? '/';

export default defineConfig({
  site,
  base,

  integrations: [
    starlight({
      title: 'template-oss',
      description: 'Documentation for template-oss.',
      social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/rxova/template-oss' }],
      editLink: {
        baseUrl: 'https://github.com/rxova/template-oss/edit/main/apps/docs/',
      },
      sidebar: [
        { label: 'Start here', items: [{ autogenerate: { directory: 'start' } }] },
        { label: 'Reference', items: [{ autogenerate: { directory: 'reference' } }] },
      ],
      plugins: [
        // A link that rots fails the build, instead of a reader finding it.
        starlightLinksValidator({ errorOnRelativeLinks: false }),
      ],
    }),
  ],
});
