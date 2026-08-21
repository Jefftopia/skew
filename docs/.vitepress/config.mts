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
        { text: 'Explained', link: '/braid-explained' },
        { text: 'Tutorials', link: '/tutorials/' },
        { text: 'Talk deck', link: '/braid-deck.html', target: '_blank' },
      ],

      sidebar: [
        {
          text: 'Braid',
          items: [
            { text: 'Braid, explained', link: '/braid-explained' },
            { text: 'Architecture', link: '/braid-architecture' },
            { text: 'From Module Federation', link: '/braid-from-module-federation' },
            { text: 'Without the gateway', link: '/braid-without-gateway' },
          ],
        },
        {
          text: 'Running it',
          items: [
            { text: 'The POC', link: '/braid-poc' },
            { text: 'CDN and deployment', link: '/braid-cdn' },
            { text: 'Failure modes', link: '/braid-failure-modes' },
            { text: 'Tooling', link: '/braid-tooling' },
          ],
        },
        {
          text: 'Tutorials',
          items: [
            { text: 'Overview', link: '/tutorials/' },
            { text: '1 · Core', link: '/tutorials/01-core' },
            { text: '2 · Build', link: '/tutorials/02-build' },
            { text: '3 · Angular core', link: '/tutorials/03-angular-core' },
            { text: '4 · Angular data', link: '/tutorials/04-angular-data' },
            { text: '5 · Braid', link: '/tutorials/05-braid' },
            { text: '6 · Data storage', link: '/tutorials/06-data-storage' },
            { text: '7 · Storefront', link: '/tutorials/07-storefront' },
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
