import {
  createVersionedStore,
  indexedDbDriver,
  webStorageDriver,
  type StorageDriver,
  type VersionedSchema,
  type VersionedStore,
} from '@skewkit/core';

export type DriverKind = 'local' | 'indexeddb';

/**
 * The remote's end of the driver choice.
 *
 * A near-copy of the host's `shared-store.ts`, duplicated for the usual
 * reason: two independently built applications, neither able to import from
 * the other. The `sessionStorage` key below is the entire contract.
 *
 * This one matters more than it looks. The host's toggle switches *which
 * browser store the demo uses*, and if this build ignored it the two would be
 * reading different stores — the host would write a record and this build
 * would report "nothing written yet", which reads as a bug in the library
 * rather than a bug in the demo's plumbing.
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

function driverFor(kind: DriverKind): StorageDriver {
  return kind === 'indexeddb'
    ? indexedDbDriver({ dbName: 'skew-demo' })
    : webStorageDriver('local');
}

/**
 * Builds a store on the currently-selected driver.
 *
 * Rebuilt per call rather than cached, because the host can flip the driver
 * between any two operations and a captured store would keep writing to the
 * old one.
 */
export function storeOn<T>(schema: VersionedSchema<T>): VersionedStore<T> {
  return createVersionedStore(schema, { driver: driverFor(readDriverKind()) });
}

/** Raw bytes at a key, read without going through `@skewkit/core`. */
export async function rawAt(fullKey: string): Promise<string | null> {
  if (readDriverKind() === 'local') {
    try {
      return globalThis.localStorage?.getItem(fullKey) ?? null;
    } catch {
      return null;
    }
  }

  return new Promise((resolve) => {
    try {
      const open = indexedDB.open('skew-demo', 1);
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
