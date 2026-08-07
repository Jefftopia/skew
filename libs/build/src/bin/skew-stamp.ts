#!/usr/bin/env node
import { stamp } from '../lib/stamp.js';

/**
 * skew-stamp — writes build identity and the skew manifest.
 *
 *   skew-stamp --out src/generated/build-id.ts \
 *              --manifest dist/app/browser/skew-manifest.json \
 *              --assets   dist/app/browser
 */
function parseArgs(argv: readonly string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token?.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

const USAGE = `skew-stamp — stamp build identity for version-skew detection

  --out <path>       TypeScript file to generate  (default: src/generated/build-id.ts)
  --manifest <path>  JSON manifest to emit        (optional, but required for probing)
  --assets <dir>     Output dir to scan for chunks(optional, enriches the manifest)
  --build-id <id>    Override the derived id      (default: git SHA, else SKEW_BUILD_ID)
  --built-at <iso>   Override the timestamp
  --help
`;

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  if (args['help']) {
    process.stdout.write(USAGE);
    return;
  }

  const out = typeof args['out'] === 'string' ? args['out'] : 'src/generated/build-id.ts';
  const manifest = typeof args['manifest'] === 'string' ? args['manifest'] : undefined;
  const assetDir = typeof args['assets'] === 'string' ? args['assets'] : undefined;
  const buildId = typeof args['build-id'] === 'string' ? args['build-id'] : undefined;
  const builtAt = typeof args['built-at'] === 'string' ? args['built-at'] : undefined;

  const result = stamp({ out, manifest, assetDir, buildId, builtAt });

  const moduleCount = Object.keys(result.modules).length;
  process.stdout.write(
    `skew: ${result.buildId} @ ${result.builtAt}\n` +
      `  identity → ${out}\n` +
      (manifest ? `  manifest → ${manifest}${moduleCount ? ` (${moduleCount} modules)` : ''}\n` : ''),
  );
}

main();
