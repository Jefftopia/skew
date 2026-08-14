import { defineConfig } from 'vite';
import { resolve } from 'node:path';

/**
 * One project, two build outputs.
 *
 * `build` (this config, default) produces the **standalone app**: an index.html plus a hashed
 * bundle, deployable to object storage or any static host. The **library** build is `@nx/js:tsc`
 * in project.json — plain ESM with type declarations, React left external — because a mountable
 * component should ship as modules the consumer's own bundler can treeshake, not as a
 * pre-bundled blob with a second React inside it.
 */
export default defineConfig({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/libs/braid-console',
  esbuild: { jsx: 'automatic' },
  build: {
    outDir: '../../dist/apps/braid-console',
    emptyOutDir: true,
    target: 'es2022',
    reportCompressedSize: true,
  },
  resolve: {
    alias: [
      {
        find: '@skewkit/braid-gateway',
        replacement: resolve(import.meta.dirname, '../braid-gateway/src/index.ts'),
      },
      {
        find: '@skewkit/braid-registry',
        replacement: resolve(import.meta.dirname, '../braid-registry/src/index.ts'),
      },
    ],
  },
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['src/**/*.{test,spec}.{js,ts,tsx}'],
    reporters: ['default'],
  },
});
