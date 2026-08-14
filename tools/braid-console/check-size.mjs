#!/usr/bin/env node
/**
 * Enforces the console's size budget.
 *
 * "Slim" is only meaningful as a number. These are checked against the *app* build, which is the
 * pessimistic case: it bundles React, whereas the library build leaves it to the host. If a
 * feature cannot fit, that is information about the feature.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';

// One budget, not two: the console's stylesheet ships *inside* the JS as a string, so a
// consumer needs no CSS loader and cannot forget a side-effect import. A separate CSS line would
// report 0.0 kB and mean nothing.
const BUDGETS = { js: 140 * 1024 };
const DIST = 'dist/apps/braid-console/assets';

const totals = { js: 0 };

let files;
try {
  files = await readdir(DIST);
} catch {
  console.error(`braid-console: no build at ${DIST} — run \`nx build-app braid-console\` first`);
  process.exit(1);
}

for (const file of files) {
  const path = join(DIST, file);
  if (!(await stat(path)).isFile()) continue;
  if (!file.endsWith('.js') && !file.endsWith('.css')) continue;
  totals.js += gzipSync(await readFile(path)).length;
}

const kb = (bytes) => `${(bytes / 1024).toFixed(1)} kB`;
let failed = false;

for (const [kind, budget] of Object.entries(BUDGETS)) {
  const used = totals[kind];
  const over = used > budget;
  failed ||= over;
  const pct = Math.round((used / budget) * 100);
  console.log(`  ${over ? '✗' : '✓'} ${kind} + css  ${kb(used).padStart(9)} gzipped  of ${kb(budget)}  (${pct}%)`);
}

if (failed) {
  console.error('\nbraid-console: over budget. Cut something, or change the budget deliberately.');
  process.exit(1);
}
