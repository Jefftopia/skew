#!/usr/bin/env node
/**
 * Deploys one of the two federated demo apps — the way a pipeline would.
 *
 *   node tools/deploy-demo.mjs host
 *   node tools/deploy-demo.mjs remote [--id my-build]
 *
 * The point of routing this through a script rather than a chain of `&&` in
 * package.json is that a deployment has to be *one* identity used in three
 * places, and the shell makes that awkward:
 *
 *   1. `skew-stamp --out …`      before the build, so the bundle knows its own id
 *   2. the build itself
 *   3. `skew-stamp --manifest …` after the build, so the origin can be asked
 *
 * Steps 1 and 3 must agree exactly. Two `skew-stamp` invocations would each
 * default `builtAt` to their own `Date.now()`, and a client comparing itself
 * against an origin that claims to be four seconds newer would classify itself
 * as stale on every single load.
 *
 * Each run increments a build number, so "redeploy the remote" produces a
 * genuinely different deployment rather than an identical rebuild.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

const APPS = {
  host: { project: 'prod-host', dir: 'apps/prod-host', manifest: true },
  remote: { project: 'prod-remote', dir: 'apps/prod-remote', manifest: false },
};

const [which, ...rest] = process.argv.slice(2);
const app = APPS[which];
if (!app) {
  console.error(
    `usage: node tools/deploy-demo.mjs <host|remote> [--id <buildId>]`,
  );
  process.exit(1);
}

const idFlag = rest.indexOf('--id');
const counterFile = join('tmp', 'skew-demo', `${which}.build`);

/** Monotonic per-app build number, so successive deploys are distinguishable. */
function nextBuildNumber() {
  const current = existsSync(counterFile)
    ? Number(readFileSync(counterFile, 'utf8').trim())
    : 0;
  const next = Number.isFinite(current) ? current + 1 : 1;
  mkdirSync(dirname(counterFile), { recursive: true });
  writeFileSync(counterFile, String(next));
  return next;
}

const buildId =
  idFlag !== -1 ? rest[idFlag + 1] : `${app.project}-${nextBuildNumber()}`;
const builtAt = new Date().toISOString();

const stamp = (args) =>
  execFileSync('node', ['dist/libs/build/src/bin/skew-stamp.js', ...args], {
    stdio: 'inherit',
  });

const nx = (args) => execFileSync('npx', ['nx', ...args], { stdio: 'inherit' });

console.log(`\n▸ deploying ${app.project} as ${buildId} @ ${builtAt}\n`);

// `skew-stamp` ships as a compiled binary, so its own library has to exist first.
nx(['build', 'build-tools']);

// 1 — the identity the bundle carries.
stamp([
  '--out',
  `${app.dir}/src/generated/build-id.ts`,
  '--build-id',
  buildId,
  '--built-at',
  builtAt,
]);

// 2 — the build. `--skip-nx-cache` because the stamp is an input Nx cannot see
//     changing in a way that matters: two deploys of identical source are still
//     two deploys, and reusing the cached output would defeat the whole demo.
nx(['build', app.project, '--skip-nx-cache']);

const outDir = `dist/apps/${app.project}/browser`;

// 3 — what the origin serves when a client asks "which build are you?".
//     Only the host is probed; the remote is discovered through its own
//     `remoteEntry.json`, which Native Federation already versions for us.
if (app.manifest) {
  stamp([
    '--out',
    'tmp/skew-demo/discard.ts',
    '--manifest',
    `${outDir}/skew-manifest.json`,
    '--build-id',
    buildId,
    '--built-at',
    builtAt,
  ]);

  /**
   * A second, deliberately *older* manifest.
   *
   * This is not a mock. It is a real artifact describing a real earlier state,
   * and it is what an origin actually serves in two common situations: a CDN
   * still holding an entry document from before the deploy, and a rollback that
   * has reached some nodes but not all of them. The host reaches it by adding
   * `?origin=rollback`, and the probe fetches it over the network like any
   * other manifest.
   */
  const rolledBack = {
    buildId: `${app.project}-rolled-back`,
    builtAt: new Date(Date.parse(builtAt) - 60 * 60 * 1000).toISOString(),
  };
  writeFileSync(
    `${outDir}/skew-manifest-rollback.json`,
    JSON.stringify(rolledBack, null, 2) + '\n',
  );
  console.log(`  rollback manifest → ${outDir}/skew-manifest-rollback.json`);
}

console.log(`\n✔ ${app.project} deployed as ${buildId}\n`);
