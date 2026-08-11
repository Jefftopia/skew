import { SkewResult, err } from './result.js';
import { VersionedSchema } from './versioned.js';
import { isSkewDisabled } from './disabled.js';

/**
 * Versioned persistence.
 *
 * The failure this exists to prevent is the quiet one. A service that does
 * `JSON.parse(raw) as T` is asserting a shape it has not checked; the moment
 * the model changes, every cached record on every user's machine has the old
 * shape while being typed as the new one. You get `undefined` deep inside a
 * renderer rather than a clean failure at the boundary.
 */

/** Minimal key/value contract. Sync drivers may return values directly. */
export interface StorageDriver {
  readonly sync: boolean;
  get(key: string): string | null | Promise<string | null>;
  set(key: string, value: string): void | Promise<void>;
  remove(key: string): void | Promise<void>;
  keys?(): string[] | Promise<string[]>;
}

export interface VersionedStoreOptions {
  readonly driver: StorageDriver;
  /** Namespace for keys. Defaults to the schema name. */
  readonly keyPrefix?: string;
  /** Stamped onto envelopes so a bad record can be attributed to a deployment. */
  readonly buildId?: string;
  /**
   * Called whenever a read fails. The default is silence — callers inspect the
   * returned result — but wiring this to telemetry is how you discover that a
   * migration is wrong before users report it.
   */
  readonly onReadFailure?: (
    key: string,
    failure: Extract<SkewResult<never>, { ok: false }>,
  ) => void;
  /**
   * Write records back at the current version after a successful *migrated*
   * read ("read-repair"). Each old record then pays its migration once
   * instead of on every read — and stops appearing in `migratedFrom`
   * telemetry, which is what makes eventually retiring its steps (see
   * `VersionedOptions.base`) provable rather than hopeful.
   *
   * Downgraded reads (`downgradedFrom` set) are never written back:
   * persisting the lossy projection would overwrite the newer record a
   * newer build still needs.
   */
  readonly rewriteOnRead?: boolean;
}

export interface VersionedStore<T> {
  /** Reads and migrates. Returns a result — never throws on stale data. */
  get(key: string): Promise<SkewResult<T>>;
  /**
   * Synchronous read, available only on sync drivers (localStorage, memory).
   * Returns `null` on an async driver rather than lying about it.
   *
   * Exists because a signal or hook initialiser reading from localStorage
   * should not have to flash empty state through a microtask.
   */
  peek(key: string): SkewResult<T> | null;
  set(key: string, value: T): Promise<void>;
  remove(key: string): Promise<void>;
  /** Fully-qualified storage key, exposed for debugging and cache-busting. */
  keyFor(key: string): string;
}

export function createVersionedStore<T>(
  schema: VersionedSchema<T>,
  options: VersionedStoreOptions,
): VersionedStore<T> {
  const {
    driver,
    keyPrefix = schema.name,
    buildId,
    onReadFailure,
    rewriteOnRead = false,
  } = options;
  const keyFor = (key: string) => `${keyPrefix}:${key}`;

  function parse(key: string, raw: string | null): SkewResult<T> {
    if (raw === null) {
      return err(
        'invalid',
        0,
        schema.version,
        `[${schema.name}] nothing stored at "${key}"`,
      );
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch (cause) {
      return err(
        'invalid',
        0,
        schema.version,
        `[${schema.name}] stored value is not JSON`,
        cause,
      );
    }
    const result = schema.read(decoded);
    if (!result.ok) onReadFailure?.(key, result);
    else if (
      rewriteOnRead &&
      result.migratedFrom !== null &&
      !isSkewDisabled()
    ) {
      // Read-repair: persist the migrated record at the current version.
      // Only for *upward* migrations — a downgraded read is a lossy
      // projection of a newer record, and writing it back would destroy data.
      try {
        void driver.set(
          keyFor(key),
          JSON.stringify(schema.write(result.value, buildId)),
        );
      } catch {
        // A failing repair is a cache-write failure; the read still succeeded.
      }
    }
    return result;
  }

  return {
    keyFor,

    async get(key: string): Promise<SkewResult<T>> {
      const raw = await driver.get(keyFor(key));
      return parse(key, raw);
    },

    peek(key: string): SkewResult<T> | null {
      if (!driver.sync) return null;
      const raw = driver.get(keyFor(key)) as string | null;
      return parse(key, raw);
    },

    async set(key: string, value: T): Promise<void> {
      // Not public API — see `disabled.ts`. Writing the bare value is what a
      // codebase without envelopes does, and it is the write side of the
      // problem: nothing in the record says which build authored it, so no
      // future reader can tell.
      const stored = isSkewDisabled() ? value : schema.write(value, buildId);
      await driver.set(keyFor(key), JSON.stringify(stored));
    },

    async remove(key: string): Promise<void> {
      await driver.remove(keyFor(key));
    },
  };
}

// --- drivers ---------------------------------------------------------------

/** In-memory driver. The default in tests and on the server. */
export function memoryDriver(seed?: Map<string, string>): StorageDriver {
  const map = seed ?? new Map<string, string>();
  return {
    sync: true,
    get: (k) => map.get(k) ?? null,
    set: (k, v) => void map.set(k, v),
    remove: (k) => void map.delete(k),
    keys: () => [...map.keys()],
  };
}

/**
 * Web Storage driver. Degrades to memory when storage is unavailable —
 * Safari private mode, disabled cookies, or SSR — so a read never throws in a
 * place the caller cannot reasonably handle it.
 */
export function webStorageDriver(
  kind: 'local' | 'session' = 'local',
  win:
    | { localStorage?: Storage; sessionStorage?: Storage }
    | undefined = globalThis as never,
): StorageDriver {
  const store = kind === 'local' ? win?.localStorage : win?.sessionStorage;
  if (!store || !isUsable(store)) return memoryDriver();

  return {
    sync: true,
    get: (k) => store.getItem(k),
    set: (k, v) => {
      try {
        store.setItem(k, v);
      } catch {
        // Quota exceeded. A cache write failing is not worth breaking a save
        // the user asked for; the next read simply misses.
      }
    },
    remove: (k) => store.removeItem(k),
    keys: () => Object.keys(store),
  };
}

function isUsable(store: Storage): boolean {
  const probe = '__skew_probe__';
  try {
    store.setItem(probe, '1');
    store.removeItem(probe);
    return true;
  } catch {
    return false;
  }
}

/** Configuration options for the IndexedDB driver. */
export interface IndexedDbDriverOptions {
  /** The name of the IndexedDB database. Defaults to "skew-store". */
  readonly dbName?: string;
  /** The name of the object store. Defaults to "keyval". */
  readonly storeName?: string;
}

/**
 * IndexedDB driver for async, large-capacity storage.
 * Degrades gracefully on failure (e.g. if IndexedDB is blocked).
 */
export function indexedDbDriver(
  options: IndexedDbDriverOptions = {},
): StorageDriver {
  const { dbName = 'skew-store', storeName = 'keyval' } = options;
  let dbPromise: Promise<IDBDatabase> | null = null;

  function getDb(): Promise<IDBDatabase> {
    if (dbPromise) return dbPromise;
    if (typeof indexedDB === 'undefined') {
      return Promise.reject(new Error('IndexedDB is not available'));
    }

    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(dbName, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(storeName)) {
          db.createObjectStore(storeName);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => {
        dbPromise = null;
        reject(req.error);
      };
    });
    return dbPromise;
  }

  function run<T>(
    mode: IDBTransactionMode,
    callback: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> {
    return getDb().then(
      (db) =>
        new Promise<T>((resolve, reject) => {
          const tx = db.transaction(storeName, mode);
          const store = tx.objectStore(storeName);
          const req = callback(store);
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        }),
    );
  }

  return {
    sync: false,
    get: async (key) => {
      try {
        const val = await run<string>('readonly', (store) => store.get(key));
        return val ?? null;
      } catch {
        return null;
      }
    },
    set: async (key, value) => {
      try {
        await run('readwrite', (store) => store.put(value, key));
      } catch {
        // Fail silently on quota exceeded or other errors
      }
    },
    remove: async (key) => {
      try {
        await run('readwrite', (store) => store.delete(key));
      } catch {
        // A failed cache delete is a smaller problem than the throw would be.
      }
    },
    keys: async () => {
      try {
        return await run<string[]>(
          'readonly',
          (store) => store.getAllKeys() as IDBRequest<string[]>,
        );
      } catch {
        return [];
      }
    },
  };
}
