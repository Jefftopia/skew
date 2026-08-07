# `@skew/angular` Integrations

The Angular packages in the Skew workspace provide first-class bindings for managing version skew risk within the Angular ecosystem. 

These packages bridge the gap between `@skew/core`'s framework-agnostic primitives (envelopes, migrations, results) and Angular's reactivity and dependency injection systems.

## Packages

The Angular integration is broken down into four independent packages. **Adoption rule:** Every package depends on `@skew/core` but never on a sibling. You can adopt one, all, or none.

### 1. [`@skew/angular-core`](core/README.md)
Provides the baseline dependency injection (`provideSkewStore`, `injectSkewStore`) and reactive Signal wrappers (`injectSkewSignal`) to easily integrate `@skew/core` stores into Angular.

### 2. [`@skew/angular-router`](router/README.md)
Provides chunk recovery for lazy-loaded routes. When a chunk fails to load due to a stale origin, offline device, or deleted route, this library correctly classifies the failure and recovers without bricking the user's tab. 

### 2. [`@skew/angular-data`](data/README.md)
A normalized entity store with a durable mutation outbox. It solves the problem of `resource()` acting as a per-call cache lacking shared identity, and provides optimistic updates, rollbacks, and tag-based invalidation for versioned data.

### 3. [`@skew/angular-workflow`](workflow/README.md)
Durable multi-step flows that survive page refreshes, deployments, and device swaps. It pairs `@skew/core` migrations with Angular routing to ensure users can safely resume multi-step wizards across boundaries.

---

## Using `@skew/core` in Angular

The `@skew/angular-core` package provides the standard way to integrate `@skew/core` into an Angular app.

### Dependency Injection & Tokens
Instead of instantiating `VersionedStore` instances inline, leverage Angular's Dependency Injection. Define an injection token and provide it at the application or route level:

```ts
import { createSkewStoreToken, provideSkewStore, injectSkewStore } from '@skew/angular-core';
import { webStorageDriver } from '@skew/core';

export const USER_STORE = createSkewStoreToken<UserProfile>('USER_STORE');

export function provideUserStore() {
  return provideSkewStore(USER_STORE, UserProfileSchema, { driver: webStorageDriver('local') });
}

// Inside a component or service
const store = injectSkewStore(USER_STORE);
```

### Reactivity with Signals
`@skew/core` methods like `store.get()` return `Promise<SkewResult<T>>`, which works beautifully with modern Angular's async patterns. However, to avoid flashes of empty state during microtasks on synchronous drivers (like `localStorage`), use `injectSkewSignal()`:

```ts
import { injectSkewSignal } from '@skew/angular-core';

export class ProfileService {
  // Returns { data, error, loading, set, reload }
  user = injectSkewSignal(USER_STORE, 'me');
  
  async updateName(name: string) {
    // Optimistically updates the signal and writes to the store
    await this.user.set({ name });
  }
}
```

### Modern Angular Standards
All Skew Angular packages adhere to the following modern standards:
- **Zoneless-safe**: No dependencies on `NgZone`.
- **Standalone Only**: No `NgModule`s. All configuration happens via `provideSkew*()` functions.
- **Signals**: Reactivity is exposed via Signals rather than RxJS Observables.
- **SSR-safe**: Checks like `isPlatformBrowser` are used before interacting with `location` or `sessionStorage`.
