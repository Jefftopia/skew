import { defineConfig } from 'vite';
import { resolve } from 'node:path';

/**
 * The context bus projects payloads through real `versioned()` chains, so its tests resolve
 * `@skewkit/core` to source rather than to a build — a stubbed schema would test the stub, and the
 * behaviour under test is precisely what the migration engine does with a missing `down`.
 */
export default defineConfig({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/libs/braid',
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
    environment: 'jsdom',
    include: ['src/**/*.{test,spec}.{js,ts}'],
    reporters: ['default'],
  },
});
