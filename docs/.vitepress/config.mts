import { defineConfig } from 'vitepress';
import { withMermaid } from 'vitepress-plugin-mermaid';

/**
 * The published docs site.
 *
 * VitePress rather than plain Jekyll for two concrete reasons, both measured against these docs:
 * the 43 relative `.md` cross-links resolve correctly because VitePress rewrites them to `.html`
 * at build time (Jekyll serves them as raw downloads), and the mermaid diagrams in four files
 * render (GitHub's repo view draws them natively, GitHub Pages does not).
 *
 * The source keeps its `.md` links either way, so the docs stay readable on github.com.
 *
 * Named `.mts` deliberately: the workspace root is not `"type": "module"`, so a `.ts` config is
 * bundled as CJS and fails to require these ESM-only packages. The extension forces ESM here
 * without making the whole Nx workspace ESM.
 */
export default withMermaid(
  defineConfig({
    title: 'Braid',
    description: 'Many apps. One page. One accessibility tree.',

    // Project pages live under /<repo>/, so every asset and link URL needs that prefix — get it
    // wrong and the site renders as unstyled HTML because the CSS 404s. Overridable so a fork,
    // a rename, or a custom domain (where base is '/') does not need a code change.
    base: process.env.DOCS_BASE ?? '/braid/',

    // Planning documents are internal roadmap, not reference material. Excluded deliberately
    // rather than by oversight — publishing them is a decision, not a side effect.
    srcExclude: ['plans/**', '**/node_modules/**'],

    // The tutorials directory index is README.md so github.com renders it when browsing the
    // folder; VitePress serves a directory from index.md. Mapping it here keeps both working
    // instead of forcing a choice between them.
    rewrites: {
      'tutorials/README.md': 'tutorials/index.md',
    },

    // The deck is a standalone self-contained page; VitePress must copy it, not parse it.
    ignoreDeadLinks: true,

    themeConfig: {
      nav: [
        { text: 'Getting started', link: '/getting-started' },
        { text: 'Explained', link: '/braid-explained' },
        { text: 'Tutorials', link: '/tutorials/' },
        { text: 'Talk deck', link: '/braid-deck.html', target: '_blank' },
      ],

      /**
       * Ordered as the project is: composition first, because that is what Braid is; then the
       * version skew independently deployed apps produce; then the state layer that holds what
       * they disagree about. The tutorials are numbered to match, so the sidebar and the
       * filenames never tell a reader two different stories about where to start.
       */
      sidebar: [
        {
          text: 'Start here',
          items: [
            { text: 'Getting started', link: '/getting-started' },
            { text: 'Braid, explained', link: '/braid-explained' },
          ],
        },
        {
          text: 'Composition',
          items: [
            { text: 'Architecture', link: '/braid-architecture' },
            { text: 'From Module Federation', link: '/braid-from-module-federation' },
            { text: 'Without the gateway', link: '/braid-without-gateway' },
            { text: 'The POC', link: '/braid-poc' },
          ],
        },
        {
          text: 'Running it',
          items: [
            { text: 'CDN and deployment', link: '/braid-cdn' },
            { text: 'Failure modes', link: '/braid-failure-modes' },
            { text: 'Tooling', link: '/braid-tooling' },
          ],
        },
        {
          text: 'Tutorials',
          items: [
            { text: 'Overview', link: '/tutorials/' },
            { text: '1 \u00b7 Compose without colliding', link: '/tutorials/01-braid' },
            { text: '2 \u00b7 Version the data', link: '/tutorials/02-skew' },
            { text: '3 \u00b7 Name your build', link: '/tutorials/03-build' },
            { text: '4 \u00b7 Client storage', link: '/tutorials/04-data-storage' },
            { text: '5 \u00b7 Angular stores', link: '/tutorials/05-angular-core' },
            { text: '6 \u00b7 Angular data', link: '/tutorials/06-angular-data' },
            { text: '7 \u00b7 Storefront, end to end', link: '/tutorials/07-storefront' },
          ],
        },
        {
          text: 'Reference',
          items: [{ text: 'Architecture diagrams', link: '/architecture' }],
        },
      ],

      socialLinks: [{ icon: 'github', link: 'https://github.com/braidjs/braid' }],
      search: { provider: 'local' },
      outline: [2, 3],
    },
  }),
);
