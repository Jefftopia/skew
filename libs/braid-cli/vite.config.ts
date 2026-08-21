import { defineConfig } from 'vite';
import { resolve } from 'node:path';

/**
 * Workspace packages this project imports *as values* are aliased to their sources.
 *
 * Type-only imports need no help — they are erased before resolution — which is why most libs
 * here get by without aliases. `braid registry` actually calls into `@braidlabs/registry`, so
 * it does. Explicit aliases rather than a tsconfig-paths plugin: one fewer dependency, and the
 * mapping is visible where the failure would be.
 *
 * The `/node` subpath must precede the bare specifier — the first match wins.
 */
export default defineConfig({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/libs/braid-cli',
  resolve: {
    alias: [
      {
        find: '@braidlabs/registry/node',
        replacement: resolve(import.meta.dirname, '../braid-registry/src/node.ts'),
      },
      {
        find: '@braidlabs/registry',
        replacement: resolve(import.meta.dirname, '../braid-registry/src/index.ts'),
      },
      // reached transitively: the access matrix calls the gateway's own canList/canFetch rather
      // than reimplementing them
      {
        find: '@braidlabs/gateway',
        replacement: resolve(import.meta.dirname, '../braid-gateway/src/index.ts'),
      },
    ],
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.{test,spec}.{js,ts}'],
    reporters: ['default'],
  },
});
