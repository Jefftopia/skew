import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/libs/braid-sw',
  resolve: {
    alias: [
      {
        find: '@braidlabs/gateway',
        replacement: resolve(import.meta.dirname, '../braid-gateway/src/index.ts'),
      },
      {
        find: '@braidlabs/skew',
        replacement: resolve(import.meta.dirname, '../skew/src/index.ts'),
      },
      {
        find: '@braidlabs/data',
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
