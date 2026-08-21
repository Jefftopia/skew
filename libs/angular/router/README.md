# `@braid/angular-router`

Chunk recovery for Angular applications. 

When a lazy chunk fails to load, it can mean a flaky network, a CDN edge miss, an offline device, a deleted route, or an origin serving a stale entry document. This library provides a recovery primitive that correctly classifies the failure and takes the right action without bricking the user's tab.

## Quick Start

Enable skew recovery in your application config:

```ts
import { provideSkewRecovery } from '@braid/angular-router';
// Generate BUILD_IDENTITY with @braid/build
import { BUILD_IDENTITY } from './generated/build-id'; 

bootstrapApplication(App, {
  providers: [
    provideRouter(routes),
    provideSkewRecovery({
      identity: BUILD_IDENTITY,
      manifestUrl: '/skew-manifest.json', // Allows detection of stale origins vs deleted routes
    }),
  ],
});
```

Then, wrap your lazy imports with `lazy()`:

```ts
import { lazy } from '@braid/angular-router';

export const routes: Routes = [
  { 
    path: 'admin', 
    // The id 'admin.routes' is used to cross-reference the manifest
    loadChildren: lazy('admin.routes', () => import('./admin/routes')) 
  }
];
```

## How It Works

### 1. Pre-Classification Retry

A transient network failure shouldn't cause a page reload. `lazy()` will automatically retry the dynamic import (default: 1 retry, 250ms backoff) before surfacing a `ChunkLoadFailure` to the router. This resolves CDN misses without the user ever noticing.

### 2. Recovery Strategies

If retries are exhausted, the failure is caught by the recovery service, which classifies it and executes the configured strategy (`onStaleChunk`):

| Strategy | Behaviour |
|---|---|
| `'reload-at-target'` *(default)* | `location.assign(targetUrl)` — Hard navigates to the intended destination. This is crucial because Angular's default `deferred` URL update strategy leaves the address bar on the *previous* route upon failure. A plain `location.reload()` would discard the navigation intent. |
| `'reload-in-place'` | `location.reload()` — Refreshes the current route, abandoning the navigation. |
| `'redirect-to-fallback'` | Client-side redirect (default `/`); correct when a route was deleted in a new deployment. |
| `'notify'` | Exposes the failure via the `SkewRecoveryService` signal to let the app handle it manually. |
| `'ignore'` | Leaves the `NavigationError` to propagate untouched. |
| `(ctx) => Action` | Custom application policy based on the `StaleChunkContext`. |

### 3. Loop Prevention

If the origin is serving a stale entry document (older than your current running client), reloading will fetch the exact same stale bundles and fail again, creating an infinite loop that bricks the tab. 

`@braid/angular-router` prevents this by:
1. Probing the `manifestUrl` to determine the origin's build timestamp.
2. Refusing to automatically reload if the origin is older than the client.
3. Keeping a hard limit on automatic recoveries per session (`maxRecoveries`, default 1).

## Unsaved Work Protection

Angular does not provide a way for libraries to introspect `CanDeactivate` guards. If an automatic reload happens while a user is midway through a form, data is lost. 

To prevent this, components can register unsaved work:

```ts
import { trackUnsavedWork } from '@braid/angular-router';

@Component({ ... })
export class BulletinEditor {
  form = new FormGroup({ ... });

  constructor() {
    // Automatically cleans up when the component is destroyed
    trackUnsavedWork(() => this.form.dirty);
  }
}
```

If `respectUnsavedWork` is true (default), any pending skew recovery will downgrade its strategy to `'notify'` instead of automatically reloading the page.

## Manual Recovery UI

If a recovery degrades to `'notify'` (e.g. because of unsaved work or a loop detection), you can prompt the user to manually recover:

```ts
import { Component, inject } from '@angular/core';
import { SkewRecoveryService } from '@braid/angular-router';

@Component({
  template: `
    @if (recovery.pending()) {
      <div class="banner">
        A new version is available.
        <button (click)="recovery.recover()">Reload App</button>
      </div>
    }
  `
})
export class AppLayout {
  recovery = inject(SkewRecoveryService);
}
```
