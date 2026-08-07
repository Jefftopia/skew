# `@skew/angular-core`

First-class Angular bindings for `@skew/core`.

This package provides the baseline Dependency Injection (DI) and reactive Signal wrappers needed to integrate `@skew/core`'s versioned stores seamlessly into an Angular application.

## Quick Start

### 1. Provide the Store

Instead of manually instantiating `VersionedStore` instances inline, use `createSkewStoreToken` and `provideSkewStore` to configure it at the application or route level.

```ts
import { createSkewStoreToken, provideSkewStore } from '@skew/angular-core';
import { webStorageDriver } from '@skew/core';

// Create a typed InjectionToken
export const USER_STORE = createSkewStoreToken<UserProfile>('USER_STORE');

export function provideUserStore() {
  return provideSkewStore(USER_STORE, UserProfileSchema, { 
    driver: webStorageDriver('local'),
    keyPrefix: 'app-users'
  });
}
```

### 2. Consume via Signals

`@skew/core` operations return `Promise<SkewResult<T>>`. While this works perfectly for standard async flows, it can cause a flash of empty state in the UI if you are using a synchronous storage driver (like `localStorage`).

`injectSkewSignal()` solves this by synchronously peeking at the store to initialize the Signal. It automatically triggers a background resolution if the driver is asynchronous or if the cached data needs to be migrated.

```ts
import { Component } from '@angular/core';
import { injectSkewSignal } from '@skew/angular-core';
import { USER_STORE } from './providers';

@Component({
  template: `
    @if (user.loading()) {
      <p>Loading...</p>
    } @else if (user.error()) {
      <p>Error migrating data: {{ user.error()?.message }}</p>
    } @else if (user.data()) {
      <h1>Hello, {{ user.data()?.name }}</h1>
      <button (click)="updateName('Fin')">Change Name</button>
    }
  `
})
export class UserProfileComponent {
  // Returns { data, error, loading, set, reload }
  user = injectSkewSignal(USER_STORE, 'me');

  async updateName(name: string) {
    // Optimistically updates the signal and safely writes to the versioned store
    await this.user.set({ name });
  }
}
```

### 3. Consume the Raw Store

If you need to perform manual queries or handle `SkewResult` directly (e.g. inside an Angular service or router guard), use `injectSkewStore()`.

```ts
import { Injectable } from '@angular/core';
import { injectSkewStore } from '@skew/angular-core';
import { USER_STORE } from './providers';

@Injectable({ providedIn: 'root' })
export class SyncService {
  store = injectSkewStore(USER_STORE);

  async checkData() {
    const result = await this.store.get('me');
    
    if (!result.ok) {
      if (result.reason === 'ahead') {
        console.warn('Data was written by a newer version of the app. Need to update.');
      } else {
        console.error('Migration failure', result);
      }
    }
  }
}
```
