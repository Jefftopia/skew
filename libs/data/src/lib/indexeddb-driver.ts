import type { RecordDriver, StoredRecord } from './record-store.js';

export interface IndexedDbDriverOptions {
  /** Database name. One per application is normal; collections are object stores within it. */
  database?: string;
  /** Collections to create. IndexedDB can only create stores during a version upgrade. */
  collections: readonly string[];
  /** Injectable for tests. */
  indexedDB?: IDBFactory;
}

const PARTITION_INDEX = 'by-partition-seq';

/**
 * IndexedDB, as the source of truth.
 *
 * Why this rather than a KV shim over the same database: every operation below is **one
 * transaction over one record**. There is no read-modify-write anywhere, so two realms or two tabs
 * writing concurrently cannot lose each other's work — which a `get`-then-`set` shim absolutely can,
 * whatever storage sits underneath it.
 *
 * The `[partition, seq]` compound index is what makes `list` a range scan rather than a full read
 * plus filter, and it is why partitions stay cheap as the store grows.
 */
export function indexedDbRecordDriver(options: IndexedDbDriverOptions): RecordDriver {
  const databaseName = options.database ?? 'skew-data';
  const factory = options.indexedDB ?? globalThis.indexedDB;
  const collections = [...options.collections];

  let open: Promise<IDBDatabase> | null = null;

  function database(): Promise<IDBDatabase> {
    open ??= new Promise<IDBDatabase>((resolve, reject) => {
      if (!factory) {
        reject(new Error('skew-data: no IndexedDB in this environment'));
        return;
      }

      // Version is derived from the collection count so adding one triggers the upgrade that can
      // create it — object stores cannot be created outside `onupgradeneeded`.
      const request = factory.open(databaseName, collections.length + 1);

      request.onupgradeneeded = () => {
        const db = request.result;
        for (const collection of collections) {
          if (db.objectStoreNames.contains(collection)) continue;
          const store = db.createObjectStore(collection, { keyPath: 'id' });
          store.createIndex(PARTITION_INDEX, ['partition', 'seq']);
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('skew-data: could not open the database'));
    });

    return open;
  }

  /**
   * Object stores can only be created during a version upgrade, so a collection that was not
   * declared cannot be created on demand — and IndexedDB reports that as a bare `NotFoundError`
   * naming neither the collection nor the fix. Checking first turns an opaque failure into an
   * actionable one, which is worth the branch.
   */
  function assertDeclared(db: IDBDatabase, collection: string): void {
    if (db.objectStoreNames.contains(collection)) return;
    throw new Error(
      `skew-data: collection "${collection}" is not in this database. IndexedDB can only create ` +
        `object stores during a version upgrade, so every collection must be declared up front — ` +
        `add it to \`collections\` where the driver is created (currently: ${collections.join(', ') || 'none'}).`,
    );
  }

  async function transaction<T>(
    collection: string,
    mode: IDBTransactionMode,
    run: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> {
    const db = await database();
    assertDeclared(db, collection);
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(collection, mode);
      const request = run(tx.objectStore(collection));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error(`skew-data: ${collection} operation failed`));
    });
  }

  return {
    async put(collection, record) {
      await transaction(collection, 'readwrite', (store) => store.put(record));
    },

    async get(collection, id) {
      return (await transaction<StoredRecord | undefined>(collection, 'readonly', (store) => store.get(id))) ?? null;
    },

    async delete(collection, id) {
      await transaction(collection, 'readwrite', (store) => store.delete(id));
    },

    async list(collection, partition) {
      // Range scan over [partition, seq] — already ordered, so no sort and no full read.
      const range = IDBKeyRange.bound([partition, -Infinity], [partition, Infinity]);
      return transaction<StoredRecord[]>(collection, 'readonly', (store) =>
        store.index(PARTITION_INDEX).getAll(range),
      );
    },

    async clearPartition(collection, partition) {
      const db = await database();
      assertDeclared(db, collection);
      return new Promise<void>((resolve, reject) => {
        const tx = db.transaction(collection, 'readwrite');
        const store = tx.objectStore(collection);
        const range = IDBKeyRange.bound([partition, -Infinity], [partition, Infinity]);
        const cursor = store.index(PARTITION_INDEX).openCursor(range);

        cursor.onsuccess = () => {
          const position = cursor.result;
          if (!position) return;
          position.delete();
          position.continue();
        };

        // Resolved on the transaction, not the cursor: deleting through a cursor is only durable
        // once the transaction commits, and a sign-out purge that reported success before that
        // could leave a partition half-deleted.
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error('skew-data: purge failed'));
        tx.onabort = () => reject(tx.error ?? new Error('skew-data: purge aborted'));
      });
    },

    async highestSeq(collection) {
      const db = await database();
      assertDeclared(db, collection);
      return new Promise<number>((resolve, reject) => {
        const tx = db.transaction(collection, 'readonly');
        const cursor = tx.objectStore(collection).index(PARTITION_INDEX).openCursor(null, 'prev');

        cursor.onsuccess = () => {
          const record = cursor.result?.value as StoredRecord | undefined;
          resolve(record?.seq ?? 0);
        };
        cursor.onerror = () => reject(cursor.error ?? new Error('skew-data: could not read the sequence'));
      });
    },
  };
}
