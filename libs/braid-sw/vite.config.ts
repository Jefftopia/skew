import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/libs/braid-sw',
  resolve: {
    alias: [
      {
        find: '@skewkit/braid-gateway',
        replacement: resolve(import.meta.dirname, '../braid-gateway/src/index.ts'),
      },
      {
        find: '@skewkit/core',
        replacement: resolve(import.meta.dirname, '../core/src/index.ts'),
      },
      {
        find: '@skewkit/data',
        replacement: resolve(import.meta.dirname, '../data/src/index.ts'),
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
