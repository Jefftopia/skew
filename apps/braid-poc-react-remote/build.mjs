/**
 * Builds the React remote with esbuild.
 *
 * Deliberately not the workspace's Angular toolchain: this app is meant to look like something a
 * different team built with different tools, which is the situation Braid exists for.
 */
import { build } from 'esbuild';
import { cp, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const outdir = resolve(root, '../../dist/apps/braid-poc-react-remote');

await mkdir(outdir, { recursive: true });

await build({
  entryPoints: [resolve(root, 'src/main.tsx')],
  bundle: true,
  format: 'esm',
  target: 'es2022',
  jsx: 'automatic',
  outfile: resolve(outdir, 'main.js'),
  sourcemap: true,
  logLevel: 'info',
});

await cp(resolve(root, 'src/index.html'), resolve(outdir, 'index.html'));
await cp(resolve(root, 'src/styles.css'), resolve(outdir, 'styles.css'));

console.log(`react remote built → ${outdir}`);
