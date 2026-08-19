import type { SkewResult, VersionedEnvelope, VersionedSchema } from '@skewkit/core';

/**
 * A record-oriented store: many addressable records per collection, rather than one blob per key.
 *
 * This is the difference that matters, and it is not a preference. The existing `StorageDriver` is
 * key→value, so a queue lives under one key and every append is a read-modify-write. Two contexts
 * interleaving that lose a write — and **IndexedDB does not fix it**, because a KV shim makes `get`
 * and `set` two separate transactions, so the race survives the driver swap.
 *
 * With addressable records the read disappears: append is `put`, remove is `delete`, and there is
 * nothing to lose. That holds on any driver, at any number of realms or tabs.
 *
 * Every value is **enveloped** by `@skewkit/core` on the way in and projected on the way out.
 * Persistence-first makes that non-negotiable rather than advisable: a record outlives the build
 * that wrote it by arbitrary amounts, so the reader is routinely a different version from the
 * writer, and there is no later moment at which envelopes can be added cheaply.
 */

/** A stored record, before projection. */
export interface StoredRecord {
  /**
   * Storage key: unique within the collection, and **partition-scoped**.
   *
   * Composed from the partition and the logical key rather than being the logical key itself.
   * Without that, two tenants share one id space — `put` overwrites across the boundary and `get`
   * reads across it, which quietly defeats the isolation partitions exist to provide. `list` was
   * filtering correctly, which is exactly why the hole was easy to miss.
   */
  id: string;
  /** The caller's id, unique within its partition. */
  key: string;
  /** Tenant partition. Records never cross one — see `partition.ts`. */
  partition: string;
  /** Monotonic within a collection; gives FIFO order without a separate index. */
  seq: number;
  /** The `@skewkit/core` envelope. */
  envelope: VersionedEnvelope;
  /**
   * Which fragment wrote it. Only that fragment may replay or reinterpret it — the reason a second
   * app cannot drop the first's queued work.
   */
  owner?: string;
}

/**
 * The storage primitive. Deliberately small, and deliberately *not* a transaction API: every
 * operation here is a single-record write or a range read, which is what removes the need for
 * transactions in the first place.
 */
export interface RecordDriver {
  put(collection: string, record: StoredRecord): Promise<void>;
  get(collection: string, id: string): Promise<StoredRecord | null>;
  delete(collection: string, id: string): Promise<void>;
  /** Records in a partition, ordered by `seq`. */
  list(collection: string, partition: string): Promise<StoredRecord[]>;
  /** Removes an entire partition. Used by sign-out; must be safe to re-run after interruption. */
  clearPartition(collection: string, partition: string): Promise<void>;
  /** Highest `seq` seen in a collection, so ordering survives a reload. */
  highestSeq(collection: string): Promise<number>;
}

export interface RecordStoreOptions<T> {
  driver: RecordDriver;
  collection: string;
  schema: VersionedSchema<T>;
  /** Stamped onto envelopes so a bad record can be attributed to a deployment. */
  buildId?: string;
  /**
   * Called when a record cannot be projected to this reader's version. The default is silence —
   * callers inspect the returned result — but wiring it to telemetry is how a wrong migration is
   * discovered before users report it.
   */
  onReadFailure?: (id: string, failure: Extract<SkewResult<never>, { ok: false }>) => void;
}

/** A record as this reader sees it, with the provenance of getting it here. */
export interface ProjectedRecord<T> {
  id: string;
  partition: string;
  seq: number;
  owner?: string;
  value: T;
  /** Set when the record was older than this reader and was migrated up. */
  migratedFrom: number | null;
  /** Set when the record was newer and was projected down — `value` is honest but lossy. */
  downgradedFrom: number | null;
  /** Paths whose values are the migration's guesses rather than what the writer recorded. */
  derivedPaths: readonly string[];
  /** Paths a down-projection discarded. */
  lossyPaths: readonly string[];
}

export interface RecordStore<T> {
  put(input: { id: string; partition: string; value: T; owner?: string; seq?: number }): Promise<number>;
  /** Partition-scoped: an id alone does not identify a record. */
  get(id: string, partition: string): Promise<ProjectedRecord<T> | null>;
  /** Every readable record in a partition, in `seq` order. Unreadable ones are reported, not thrown. */
  list(partition: string): Promise<ProjectedRecord<T>[]>;
  delete(id: string, partition: string): Promise<void>;
  clearPartition(partition: string): Promise<void>;
  /**
   * Records that could not be projected to this reader, with why.
   *
   * Separate from `list` on purpose: a caller iterating records should not have to filter failures
   * out of the same array, and a failure that is merely absent from a list is a failure nobody
   * notices.
   */
  unreadable(partition: string): Promise<{ id: string; failure: Extract<SkewResult<never>, { ok: false }> }[]>;
}

/** Partition-scoped storage key. The separator cannot appear in either half by construction. */
function storageKey(partition: string, key: string): string {
  return `${partition}\u0000${key}`;
}

export function createRecordStore<T>(options: RecordStoreOptions<T>): RecordStore<T> {
  const { driver, collection, schema, buildId, onReadFailure } = options;

  // Cached rather than read per write: `highestSeq` is a full scan on some drivers, and ordering
  // only needs to be monotonic within a process — gaps from a concurrent writer are harmless
  // because nothing derives meaning from consecutive numbers.
  let sequence: Promise<number> | null = null;

  /**
   * Allocates the next sequence number.
   *
   * Chained rather than read-then-written, and the distinction is not cosmetic: an `await` between
   * reading the counter and advancing it lets every concurrent caller observe the same value, so
   * fifty parallel appends take fifty copies of one number. Verified against real IndexedDB — the
   * in-memory tests resolved too fast to interleave and reported it as correct.
   *
   * Assigning the chain synchronously means the next caller extends *this* call's promise instead
   * of racing it, so each gets a distinct number with no lock.
   */
  function allocateSeq(): Promise<number> {
    sequence = (sequence ?? driver.highestSeq(collection)).then((last) => last + 1);
    return sequence;
  }

  function project(record: StoredRecord): ProjectedRecord<T> | null {
    const result = schema.read(record.envelope);

    if (!result.ok) {
      // The caller's id, not the storage key — a diagnostic naming an internal composite is a
      // diagnostic the caller cannot act on.
      onReadFailure?.(record.key, result);
      return null;
    }

    return {
      id: record.key,
      partition: record.partition,
      seq: record.seq,
      ...(record.owner === undefined ? {} : { owner: record.owner }),
      value: result.value,
      migratedFrom: result.migratedFrom,
      downgradedFrom: result.downgradedFrom,
      derivedPaths: result.derivedPaths,
      lossyPaths: result.lossyPaths,
    };
  }

  return {
    async put({ id, partition, value, owner, seq }) {
      const assigned = seq ?? (await allocateSeq());
      await driver.put(collection, {
        id: storageKey(partition, id),
        key: id,
        partition,
        seq: assigned,
        envelope: buildId ? schema.write(value, buildId) : schema.write(value),
        ...(owner === undefined ? {} : { owner }),
      });
      return assigned;
    },

    async get(id, partition) {
      const record = await driver.get(collection, storageKey(partition, id));
      return record ? project(record) : null;
    },

    async list(partition) {
      const records = await driver.list(collection, partition);
      return records.map(project).filter((record): record is ProjectedRecord<T> => record !== null);
    },

    async unreadable(partition) {
      const failures: { id: string; failure: Extract<SkewResult<never>, { ok: false }> }[] = [];

      for (const record of await driver.list(collection, partition)) {
        const result = schema.read(record.envelope);
        if (!result.ok) failures.push({ id: record.key, failure: result });
      }

      return failures;
    },

    delete: (id, partition) => driver.delete(collection, storageKey(partition, id)),
    clearPartition: (partition) => driver.clearPartition(collection, partition),
  };
}
