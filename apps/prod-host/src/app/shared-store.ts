import { Injectable, signal } from '@angular/core';
import {
  createVersionedStore,
  indexedDbDriver,
  webStorageDriver,
  type StorageDriver,
  type VersionedSchema,
  type VersionedStore,
} from '@skew/core';

export type DriverKind = 'local' | 'indexeddb';

/**
 * Which browser store the demo reads and writes.
 *
 * This has to live somewhere *both builds can see*, and they cannot share a
 * service — so it lives in `sessionStorage` under a fixed key, the same medium
 * `trace.ts` and the command channel already use. If the host switched to
 * IndexedDB and the remote kept using localStorage, they would be reading two
 * different stores and every scenario would silently show "nothing written
 * yet" — a broken demo that looks like a working one.
 */
const DRIVER_KEY = 'skew-demo:driver';

export function readDriverKind(): DriverKind {
  try {
    return globalThis.sessionStorage?.getItem(DRIVER_KEY) === 'indexeddb'
      ? 'indexeddb'
      : 'local';
  } catch {
    return 'local';
  }
}

export function driverFor(kind: DriverKind): StorageDriver {
  return kind === 'indexeddb'
    ? indexedDbDriver({ dbName: 'skew-demo' })
    : webStorageDriver('local');
}

/**
 * Builds a store on the currently-selected driver.
 *
 * A function rather than a cached instance, on purpose: the driver can change
 * between two clicks, and a store captured at construction time would keep
 * writing to whichever driver happened to be selected when the component was
 * created. Cheap enough to rebuild per operation.
 */
export function storeOn<T>(
  schema: VersionedSchema<T>,
  kind = readDriverKind(),
): VersionedStore<T> {
  return createVersionedStore(schema, { driver: driverFor(kind) });
}

@Injectable({ providedIn: 'root' })
export class SharedStore {
  readonly kind = signal<DriverKind>(readDriverKind());

  /**
   * Bumped whenever this build writes, so the store panel can redraw at once
   * instead of waiting for its next poll.
   *
   * The panel still polls, because the *remote* writes through its own copy of
   * this module and cannot bump a signal in the host's bundle — there is no
   * shared object between them to notify through, which is the same constraint
   * every other cross-build interaction here runs into. Polling covers that
   * case; this covers the common one instantly.
   */
  readonly revision = signal(0);

  touched(): void {
    this.revision.update((n) => n + 1);
  }

  /**
   * `localStorage` is synchronous and `IndexedDB` is not — which is the whole
   * reason `@skew/core` exposes `peek()` separately and has it return `null`
   * on an async driver rather than pretending. Worth showing in the UI.
   */
  readonly isAsync = () => this.kind() === 'indexeddb';

  setKind(next: DriverKind): void {
    this.kind.set(next);
    try {
      globalThis.sessionStorage?.setItem(DRIVER_KEY, next);
    } catch {
      /* private mode — the choice just won't survive a reload */
    }
  }

  store<T>(schema: VersionedSchema<T>): VersionedStore<T> {
    return storeOn(schema, this.kind());
  }

  /**
   * The raw bytes currently at a key, read straight from the browser store
   * rather than through `@skew/core`.
   *
   * Bypassing the library is the point: the panel should show what is
   * genuinely on disk, including when the protections are off and there is no
   * envelope around it. Reading it back through the thing being demonstrated
   * would beg the question.
   */
  async rawAt(fullKey: string): Promise<string | null> {
    if (this.kind() === 'local') {
      try {
        return globalThis.localStorage?.getItem(fullKey) ?? null;
      } catch {
        return null;
      }
    }
    return this.readIndexedDb(fullKey);
  }

  private readIndexedDb(fullKey: string): Promise<string | null> {
    return new Promise((resolve) => {
      try {
        const open = indexedDB.open('skew-demo', 1);
        // The driver creates the store on its own first write; if that has not
        // happened yet there is simply nothing to show.
        open.onupgradeneeded = () => {
          const db = open.result;
          if (!db.objectStoreNames.contains('keyval'))
            db.createObjectStore('keyval');
        };
        open.onerror = () => resolve(null);
        open.onsuccess = () => {
          const db = open.result;
          if (!db.objectStoreNames.contains('keyval')) return resolve(null);
          const req = db
            .transaction('keyval', 'readonly')
            .objectStore('keyval')
            .get(fullKey);
          req.onsuccess = () => resolve((req.result as string) ?? null);
          req.onerror = () => resolve(null);
        };
      } catch {
        resolve(null);
      }
    });
  }
}
