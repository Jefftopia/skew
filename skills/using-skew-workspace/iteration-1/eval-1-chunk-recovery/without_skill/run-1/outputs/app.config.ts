/**
 * app.config.ts
 *
 * Wires @braid/angular-router chunk recovery into the standalone app config.
 *
 * The failure mode we are fixing:
 *   1. Deploy N+1 goes out; hashed chunk files from deploy N are deleted from
 *      the origin/CDN.
 *   2. A user who loaded index.html from deploy N clicks into a lazy route.
 *   3. The dynamic import 404s -> ChunkLoadError -> navigation dies and the
 *      user is stuck until a manual refresh.
 *
 * Recovery strategy (in order):
 *   - Retry the failed chunk fetch once with a cache-busting query param
 *     (covers transient CDN/network flakes without a full reload).
 *   - If the chunk is genuinely gone, verify the origin is actually serving a
 *     NEWER build before reloading: fetch the deploy manifest
 *     (skew-manifest.json, emitted by @braid/build) with cache: 'no-store' and
 *     compare its buildId against the buildId stamped into THIS bundle.
 *       * manifest.buildId !== SKEW_BUILD_ID  -> a new build exists at the
 *         origin; a reload will pick it up. Safe to reload.
 *       * manifest.buildId === SKEW_BUILD_ID  -> the origin (or a stale CDN
 *         region) is still serving OUR build. Reloading would hand us the
 *         same stale index.html and the same missing chunk -> infinite
 *         reload loop. DO NOT reload; surface the banner instead.
 *   - Even when a reload is version-safe, it must be *user*-safe: the
 *     canAutoReload guard vetoes automatic reloads while any form on the page
 *     is dirty (half filled in). Blocked recoveries fall through to the
 *     banner so the user reloads on their own terms.
 *   - Belt-and-braces loop cap: at most one automatic reload per buildId,
 *     tracked in sessionStorage. If we reloaded once and still hit a chunk
 *     error, something is wrong upstream -> banner, not another reload.
 */
import { ApplicationConfig, provideZoneChangeDetection } from '@angular/core';
import { provideRouter, withComponentInputBinding, withViewTransitions } from '@angular/router';

import {
  provideSkewChunkRecovery,
  withChunkRetry,
  withDeployManifest,
  withReloadGuard,
  withReloadLoopProtection,
} from '@braid/angular-router';

// Stamped at build time by `skew-build stamp` (see package.json). The
// generated module exports the git SHA + timestamp identity of THIS bundle.
import { SKEW_BUILD_ID } from './skew-build-id.generated';

import { routes } from './app.routes';
import { noDirtyFormsGuard } from './recovery/dirty-form-recovery-guard';

export const appConfig: ApplicationConfig = {
  providers: [
    provideZoneChangeDetection({ eventCoalescing: true }),

    // Routes stay 100% standard (see app.routes.ts) — recovery hooks in at
    // the router level, so no per-route wrapping of loadChildren/loadComponent.
    provideRouter(routes, withComponentInputBinding(), withViewTransitions()),

    provideSkewChunkRecovery(
      // Identity of the running bundle, for staleness comparison.
      { buildId: SKEW_BUILD_ID },

      // 1) Cheap first: retry the failed import once, cache-busted, before
      //    considering anything as heavy as a reload.
      withChunkRetry({ attempts: 1, cacheBust: true }),

      // 2) Only reload when the origin provably has a newer build.
      //    `requireNewerBuild: true` is the "never loop on a stale origin"
      //    requirement: if the manifest still reports our own buildId (stale
      //    CDN region, botched deploy), automatic reload is refused and the
      //    recovery is reported as blocked with reason 'origin-stale'.
      withDeployManifest({
        url: '/skew-manifest.json',
        fetchOptions: { cache: 'no-store' },
        requireNewerBuild: true,
      }),

      // 3) Never reload over a half-filled form. When the guard returns
      //    false the recovery is reported as blocked with reason
      //    'guard-vetoed' and the banner takes over.
      withReloadGuard(noDirtyFormsGuard),

      // 4) Hard cap: one automatic reload per buildId per browser session.
      //    Anything past that is a blocked recovery -> banner.
      withReloadLoopProtection({
        maxAutoReloadsPerBuild: 1,
        storage: 'session', // sessionStorage key, keyed by buildId
      }),
    ),
  ],
};
