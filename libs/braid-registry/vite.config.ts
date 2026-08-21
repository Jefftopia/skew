import { defineConfig } from 'vite';
import { resolve } from 'node:path';

/**
 * `@braid/gateway` is a type-only import in the package itself, but the integration spec
 * calls `createGateway` for real — so tests need it resolved to source.
 */
export default defineConfig({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/libs/braid-registry',
  resolve: {
    alias: [
      {
        find: '@braid/gateway',
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
