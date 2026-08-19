import { defineConfig } from 'vite';
import { resolve } from 'node:path';

/**
 * `@skewkit/core` is a peer dependency, so tests resolve it to source rather than to a build.
 * The store's whole behavior is migration projection, which means every meaningful test exercises
 * real `versioned()` chains — a stub would test the mock.
 */
export default defineConfig({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/libs/data',
  resolve: {
    alias: [
      {
        find: '@skewkit/core',
        replacement: resolve(import.meta.dirname, '../core/src/index.ts'),
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
