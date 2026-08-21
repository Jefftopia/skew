import { Routes } from '@angular/router';
import { lazy } from '@braidlabs/angular-router';

// lazy(id, importer) wraps the dynamic import with classified recovery:
//
// - Transient failures (flaky network, a CDN edge that hasn't picked up the
//   new files yet) are retried in place first (default: 1 retry, 250ms
//   backoff) — most post-deploy ChunkLoadError spikes resolve invisibly,
//   with no reload at all.
// - Only when the retry also fails does the stale-chunk strategy from
//   provideSkewRecovery() run, with its loop- and unsaved-work guards.
//
// The first argument is a stable module id that cross-references the
// `modules` map in skew-manifest.json (populated by the postbuild
// `skew-stamp --assets` run). That map is how recovery distinguishes
// "this route's chunk was renamed by a deploy" (reload is correct) from
// "this route was deleted from the app" (reloading would 404 forever;
// redirect-to-fallback is correct). Keep the ids stable across renames of
// the underlying files.
export const routes: Routes = [
  {
    path: 'admin',
    loadChildren: lazy('admin.routes', () => import('./admin/admin.routes')),
  },
  {
    path: 'editor',
    loadChildren: lazy('editor.routes', () => import('./editor/editor.routes')),
  },
];
