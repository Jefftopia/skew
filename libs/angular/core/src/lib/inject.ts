import { inject, signal, type Signal } from '@angular/core';
import type { InjectionToken } from '@angular/core';
import type { VersionedStore, SkewErr } from '@skewkit/core';

export interface SkewSignal<T> {
  /** The current resolved value, or null if loading/failed. */
  readonly data: Signal<T | null>;
  /** The error if the read/migration failed, or null. */
  readonly error: Signal<SkewErr | null>;
  /** Whether an async read is currently running. */
  readonly loading: Signal<boolean>;
  
  /** Optimistically updates the signal and writes to the store. */
  set(value: T): Promise<void>;
  /** Reloads the data from the underlying store. */
  reload(): Promise<void>;
}

/**
 * Injects a specific key from a VersionedStore as a reactive Signal.
 * Synchronously peeks at the value first to prevent UI flicker on sync drivers.
 *
 * ```ts
 * const user = injectSkewSignal(USER_STORE, 'me');
 * ```
 */
export function injectSkewSignal<T>(token: InjectionToken<VersionedStore<T>>, key: string): SkewSignal<T> {
  const store = inject(token);
  
  // Synchronously initialize
  const peeked = store.peek(key);
  const data = signal<T | null>(peeked?.ok ? peeked.value : null);
  const error = signal<SkewErr | null>(peeked?.ok === false ? peeked : null);
  const loading = signal<boolean>(peeked === null);

  const reload = async () => {
    loading.set(true);
    const result = await store.get(key);
    loading.set(false);
    
    if (result.ok) {
      data.set(result.value);
      error.set(null);
    } else {
      error.set(result);
    }
  };

  // If we couldn't peek (async driver), load it now.
  if (peeked === null) {
    reload();
  }

  return {
    data: data.asReadonly(),
    error: error.asReadonly(),
    loading: loading.asReadonly(),
    set: async (value: T) => {
      // Optimistic update
      data.set(value);
      error.set(null);
      await store.set(key, value);
    },
    reload
  };
}

/**
 * Injects the raw VersionedStore.
 */
export function injectSkewStore<T>(token: InjectionToken<VersionedStore<T>>): VersionedStore<T> {
  return inject(token);
}
