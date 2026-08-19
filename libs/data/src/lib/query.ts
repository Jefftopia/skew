import type { SkewFailureReason, VersionedSchema } from '@skewkit/core';
import type { RecordDriver } from './record-store.js';
import { createRecordStore, type RecordStore } from './record-store.js';
import { sharedInvalidator, type Invalidator } from './invalidation.js';
import { withLock } from './locks.js';
import type { OptimisticOverlay, Outbox } from './outbox.js';
import type { PushConnection, PushRecord } from './adapters.js';

/**
 * The read path: reactive queries over a shared, persisted, skew-tolerant cache.
 *
 * Three things make this different from an ordinary query cache, and each is the reason for a
 * decision below:
 *
 * 1. **The cache is shared across applications**, because it lives in storage rather than in one
 *    app's memory. Two independently deployed apps asking for the same record fetch it once
 *    between them.
 * 2. **Records are projected per reader.** The store holds what the writer wrote; each reader
 *    migrates it to its own contract version on the way out, in either direction.
 * 3. **Provenance travels with the value.** A reader can tell a field the server reported from one
 *    a migration guessed, which is the entire reason to build on the migration engine rather than
 *    on a plain cache.
 *
 * A fourth follows from the outbox: **the optimistic view is derived, never stored.**
 *
 *     view(record) = confirmed(record) ⊕ pending(record)
 *
 * Both inputs are shared, so every app and every tab derives the same view without reconciling
 * anything, rollback is deletion rather than an undo record to keep consistent, and the queue and
 * the overlay cannot disagree because they are one thing.
 */

export type QueryStatus = 'idle' | 'loading' | 'ready' | 'error';

/**
 * A confirmation that disagreed with what the overlay predicted.
 *
 * The stored record always becomes the server's value — it is the source of truth, and there is no
 * client-wins option because you cannot make a server hold your value without another mutation.
 * What is configurable is whether the *user* is told.
 */
export interface Conflict<T> {
  /** What the overlay predicted: the confirmed value with this mutation's patch applied. */
  expected: T;
  /** What the server actually stored. */
  actual: T;
  /** The patched paths the server disagreed about. */
  paths: readonly string[];
}

export interface QueryState<T> {
  data: T | undefined;
  status: QueryStatus;
  error?: unknown;
  /** True while a fetch is in flight behind data that is already displayable. */
  refreshing: boolean;
  /** True when this value came from the shared cache rather than the network. */
  fromCache: boolean;
  /** Set when the stored record was older than this reader and was migrated up. */
  migratedFrom: number | null;
  /** Set when it was newer and was projected down — the value is honest but lossy. */
  downgradedFrom: number | null;
  /** Paths whose values are the migration's guesses rather than what the writer recorded. */
  derivedPaths: readonly string[];
  /** Paths a down-projection discarded. */
  lossyPaths: readonly string[];
  /**
   * Set when the stored record could not be read by this reader, and why.
   *
   * The interesting value is `'ahead'`: a record written by a build newer than this one, with no
   * down-migration available. The record is perfectly good and merely from the future — so the
   * honest move is to say so and refetch at this reader's own version, rather than discard it as
   * corrupt or guess at fields the writer never sent.
   */
  unreadable: SkewFailureReason | null;
  /** True while an optimistic overlay is applied — `data` includes work the server has not seen. */
  pending: boolean;
  /** Set when a confirmation disagreed with the overlay, under the `'raise'` policy. */
  conflict: Conflict<T> | null;
}

export interface Query<T> {
  readonly current: QueryState<T>;
  subscribe(listener: (state: QueryState<T>) => void): () => void;
  /** Forces a fetch, bypassing the cache. */
  refetch(): Promise<void>;
  dispose(): void;
}

export interface QueryDefinition<T> {
  /** Cache key. Identifies the record, and is what makes two apps share one fetch. */
  key: string;
  /** What this query depends on, for invalidation. */
  tags?: string[];
  schema: VersionedSchema<T>;
  fetch: (signal: AbortSignal) => Promise<unknown>;
  /**
   * Serve the cached value immediately and refresh behind it. Defaults to true — a warm partition
   * is the point of persisting, and waiting on the network to show data you already have discards
   * it.
   */
  staleWhileRevalidate?: boolean;
}

export interface DataClientOptions {
  driver: RecordDriver;
  /**
   * The tenant partition: `hash(userId, actingAs)`.
   *
   * Read on every access rather than captured, so switching tenants is a pointer move and the
   * previous partition stays warm on disk.
   */
  partition: () => string;
  collection?: string;
  buildId?: string;
  crossTabInvalidation?: boolean;
  /** Called whenever the network is actually hit. What the demo's "fetched once" counter reads. */
  onFetch?: (key: string) => void;
  invalidator?: Invalidator;
  /**
   * The queue that also supplies the optimistic overlay. Without one, `mutate` has nowhere to
   * record a write it cannot yet send, so queries show only confirmed values.
   */
  outbox?: Outbox;
}

/** What to do when the server's value disagrees with what the overlay predicted. */
export type ConflictPolicy<T> = 'raise' | 'accept' | ((conflict: Conflict<T>) => T);

export interface MutationDefinition<T> {
  /** The record this changes. The same key its queries read, or nothing overlays. */
  key: string;
  schema: VersionedSchema<T>;
  /**
   * Identifies the mutation *kind*. A queued entry outlives the closure that made it, and after a
   * reload this is how it finds its runner again.
   */
  mutationId: string;
  /** Replayable input for that runner. */
  input: unknown;
  /** Applied over the confirmed record until the server answers. */
  patch: Partial<T>;
  /** Set when the write deletes the record: readers show it gone before the server agrees. */
  removes?: boolean;
  /** Sends it. Resolves with the server's version of the record. */
  send: () => Promise<unknown>;
  /** Tags to mark stale once the write lands. */
  tags?: string[];
  /**
   * Defaults to `'raise'`, because the silent version changes the screen under someone who just
   * typed something. "I set it to X, why does it say Y?" is a support ticket, and in an advisory
   * context it is a support ticket about someone's money. Silence is opted into per mutation, by a
   * team that knows the field is server-authoritative.
   */
  onConflict?: ConflictPolicy<T>;
  /** Contract version of `input`, carried on the queued entry. */
  schemaVersion?: number;
}

export interface MutationOutcome<T> {
  /** `'queued'` means the send failed and the entry is waiting; the overlay stays applied. */
  status: 'confirmed' | 'queued';
  /** The outbox entry this created. Still queued when `status` is `'queued'`. */
  entryId: string;
  /** What was stored. Absent while queued — nothing has been confirmed yet. */
  value?: T;
  conflict?: Conflict<T>;
  /** Why the send failed, when it did. */
  error?: unknown;
}

export interface DataClient {
  query<T>(definition: QueryDefinition<T>): Query<T>;
  /**
   * Writes: queue, overlay, send, confirm.
   *
   * Optimistic and offline are the same mechanism here rather than two features that must be kept
   * in agreement — a mutation whose send fails is simply one whose overlay outlives the attempt.
   */
  mutate<T>(definition: MutationDefinition<T>): Promise<MutationOutcome<T>>;
  /** Dismisses a raised conflict, once the user has seen it. */
  acknowledgeConflict(key: string): void;
  /**
   * Connects a push stream — a subscription, socket, or SSE feed — to the store.
   *
   * Server-pushed records land through the same enveloping path as everything else, and readers are
   * refreshed *from storage* rather than sent back to the network: the pushed record already is the
   * newest thing anyone has. Returns a disposer.
   */
  connect<T>(connection: PushConnection<T>): () => void;
  /** Marks tags stale across every app on the page. */
  invalidate(...tags: string[]): void;
  /** Drops a tenant's cached records. Sign-out, or a tenant switch that should not stay warm. */
  clearPartition(partition?: string): Promise<void>;
  close(): void;
}

const DEFAULT_COLLECTION = 'entities';

/**
 * The tag a key's overlay changes travel on.
 *
 * Ordinary tags mean "this data is stale, go and look again"; this one means "the pending set
 * moved, recompute the view you already have". Sharing one tag space would make every keystroke of
 * optimistic state a network refetch.
 */
function pendingTag(key: string): string {
  return `skew:pending#${key}`;
}

export function createDataClient(options: DataClientOptions): DataClient {
  const collection = options.collection ?? DEFAULT_COLLECTION;
  // Shared per partition, so a mutation in one application refreshes another's view of the same
  // record. A private invalidator per client would make cross-app invalidation silently not work.
  const invalidator =
    options.invalidator ??
    sharedInvalidator({
      partition: options.partition(),
      ...(options.crossTabInvalidation === undefined ? {} : { crossTab: options.crossTabInvalidation }),
    });

  const stores = new Map<VersionedSchema<unknown>, RecordStore<unknown>>();

  /**
   * Raised conflicts, per key, held by the client that wrote.
   *
   * Deliberately not shared: the app whose user typed the value is the one that can explain what
   * happened to it. Broadcasting "someone, somewhere, was disagreed with" to five fragments gives
   * four of them a message they cannot act on.
   */
  const conflicts = new Map<string, Conflict<unknown>>();

  /** Why a key's stored record could not be read, last time anyone tried. */
  const unreadable = new Map<string, SkewFailureReason>();

  /**
   * One store per schema, because the store *is* the projection: the same bytes read through two
   * chains give two different values, which is the point.
   */
  function storeFor<T>(schema: VersionedSchema<T>): RecordStore<T> {
    let store = stores.get(schema as VersionedSchema<unknown>);
    if (!store) {
      store = createRecordStore<unknown>({
        driver: options.driver,
        collection,
        schema: schema as VersionedSchema<unknown>,
        ...(options.buildId === undefined ? {} : { buildId: options.buildId }),
        // Recorded per key rather than thrown: a record this reader cannot project is a fact about
        // the pair of them, and the query that asked is the only place that can act on it.
        onReadFailure: (id, failure) => void unreadable.set(id, failure.reason),
      });
      stores.set(schema as VersionedSchema<unknown>, store);
    }
    return store as RecordStore<T>;
  }

  return {
    query<T>(definition: QueryDefinition<T>): Query<T> {
      return createQuery(definition, {
        store: storeFor(definition.schema),
        partition: options.partition,
        invalidator,
        conflicts,
        unreadable,
        ...(options.onFetch === undefined ? {} : { onFetch: options.onFetch }),
        ...(options.outbox === undefined ? {} : { outbox: options.outbox }),
      });
    },

    async mutate<T>(definition: MutationDefinition<T>): Promise<MutationOutcome<T>> {
      const outbox = options.outbox;
      if (!outbox) {
        throw new TypeError(
          '[skew/data] mutate() needs an `outbox` on the client: the overlay it applies and the ' +
            'queue that survives a failed send are the same records, so there is nowhere to put ' +
            'the write without one.',
        );
      }

      const store = storeFor(definition.schema);
      const partition = options.partition();
      const confirmed = (await store.get(definition.key, partition))?.value;
      const expected = { ...(confirmed ?? {}), ...definition.patch } as T;

      // Queued *before* sending, not on failure. The entry is what readers overlay, so a write that
      // is only recorded once it fails is a write nobody can see while it is in flight.
      const entryId = await outbox.enqueue({
        mutationId: definition.mutationId,
        input: definition.input,
        optimistic: [
          {
            key: definition.key,
            patch: definition.patch as Record<string, unknown>,
            ...(definition.removes ? { removed: true } : {}),
          },
        ],
        ...(definition.schemaVersion === undefined ? {} : { schemaVersion: definition.schemaVersion }),
      });
      invalidator.invalidate(pendingTag(definition.key));

      let actual: T;
      try {
        actual = (await definition.send()) as T;
      } catch (error) {
        // The entry stays queued and the overlay stays applied: from the user's point of view the
        // change happened, and the queue is what will eventually make that true.
        return { status: 'queued', entryId, error };
      }

      const policy = definition.onConflict ?? 'raise';
      const paths = disagreements(expected, actual, Object.keys(definition.patch));
      let stored = actual;
      let conflict: Conflict<T> | undefined;

      if (paths.length > 0) {
        if (typeof policy === 'function') stored = policy({ expected, actual, paths });
        else if (policy === 'raise') conflict = { expected, actual, paths };
      }

      await store.put({ id: definition.key, partition, value: stored });
      await outbox.remove(entryId);

      if (conflict) conflicts.set(definition.key, conflict as Conflict<unknown>);
      else conflicts.delete(definition.key);

      // The pending tag first so the overlay lifts against the value just stored; the caller's tags
      // after, for the queries that depend on this record without reading this key.
      invalidator.invalidate(pendingTag(definition.key), ...(definition.tags ?? []));

      return { status: 'confirmed', entryId, value: stored, ...(conflict ? { conflict } : {}) };
    },

    acknowledgeConflict(key) {
      if (!conflicts.delete(key)) return;
      invalidator.invalidate(pendingTag(key));
    },

    connect<T>(connection: PushConnection<T>): () => void {
      const store = storeFor(connection.schema);
      const controller = new AbortController();

      const sink = {
        async receive(record: PushRecord) {
          if (controller.signal.aborted) return;
          await store.put({ id: record.key, partition: options.partition(), value: record.value as T });

          // The pending tag, not the record's own: this refreshes readers from the store, where the
          // value already is. Marking the record stale would answer a push by fetching the thing the
          // push just delivered.
          invalidator.invalidate(
            pendingTag(record.key),
            ...(record.tags ?? connection.tags?.(record.key) ?? []),
          );
        },
      };

      const disposer = connection.source(sink, controller.signal);

      return () => {
        controller.abort();
        // A stream may report its disposer synchronously or after connecting; both are settled here
        // so a caller never has to know which transport it was handed.
        void Promise.resolve(disposer).then((dispose) => dispose?.());
      };
    },

    invalidate(...tags) {
      invalidator.invalidate(...tags);
    },

    async clearPartition(partition) {
      await options.driver.clearPartition(collection, partition ?? options.partition());
    },

    close() {
      invalidator.close();
    },
  };
}

function createQuery<T>(
  definition: QueryDefinition<T>,
  context: {
    store: RecordStore<T>;
    partition: () => string;
    invalidator: Invalidator;
    conflicts: Map<string, Conflict<unknown>>;
    unreadable: Map<string, SkewFailureReason>;
    onFetch?: (key: string) => void;
    outbox?: Outbox;
  },
): Query<T> {
  const listeners = new Set<(state: QueryState<T>) => void>();
  const controller = new AbortController();
  const staleWhileRevalidate = definition.staleWhileRevalidate ?? true;

  let state: QueryState<T> = {
    data: undefined,
    status: 'idle',
    refreshing: false,
    fromCache: false,
    migratedFrom: null,
    downgradedFrom: null,
    derivedPaths: [],
    lossyPaths: [],
    unreadable: null,
    pending: false,
    conflict: null,
  };

  const emit = (next: Partial<QueryState<T>>) => {
    state = { ...state, ...next };
    for (const listener of listeners) listener(state);
  };

  /**
   * Reads the view: the stored record with every queued patch for this key applied over it.
   *
   * Patches are applied in queue order, so two edits to the same field settle the way they will
   * settle on the server. The overlay is recomputed from the outbox on every read rather than
   * accumulated, which is what makes rollback a deletion — remove the entry and the next read
   * simply does not include it.
   */
  async function readView(): Promise<boolean> {
    context.unreadable.delete(definition.key);
    const record = await context.store.get(definition.key, context.partition());
    const failure = context.unreadable.get(definition.key) ?? null;
    // An overlay needs something to sit on. A patch alone is not a record — it names the fields one
    // write changed, not every field this reader's contract requires.
    if (!record) {
      // Reported before returning, so a reader that is behind learns *why* it is about to refetch
      // rather than watching an apparently empty cache go back to the network.
      if (failure) emit({ unreadable: failure });
      return false;
    }

    const overlays: OptimisticOverlay[] = context.outbox ? await context.outbox.pendingFor(definition.key) : [];
    const data = overlays.reduce<T | undefined>(
      (value, overlay) => (overlay.removed ? undefined : ({ ...(value ?? {}), ...overlay.patch } as T)),
      record.value,
    );

    emit({
      data,
      status: 'ready',
      fromCache: true,
      migratedFrom: record.migratedFrom,
      downgradedFrom: record.downgradedFrom,
      derivedPaths: record.derivedPaths,
      lossyPaths: record.lossyPaths,
      unreadable: null,
      pending: overlays.length > 0,
      conflict: (context.conflicts.get(definition.key) as Conflict<T> | undefined) ?? null,
    });
    return true;
  }

  /**
   * Fetches, under a per-key lock, re-checking the cache once it is held.
   *
   * The lock is what makes "these two apps fetched this once between them" true even when they ask
   * *simultaneously*. Realms are separate JavaScript contexts, so an in-process in-flight map
   * cannot dedupe across them; `navigator.locks` can, and the second app finds the record already
   * written when its turn comes.
   */
  async function fetchAndStore(force: boolean): Promise<void> {
    if (controller.signal.aborted) return;
    emit({ refreshing: true, ...(state.data === undefined ? { status: 'loading' as const } : {}) });

    try {
      await withLock(
        `skew:data:fetch:${context.partition()}:${definition.key}`,
        async () => {
          if (controller.signal.aborted) return;
          // Double-checked: another context may have fetched while this one waited for the lock.
          if (!force && (await readView())) return;

          context.onFetch?.(definition.key);
          const raw = await definition.fetch(controller.signal);
          if (controller.signal.aborted) return;

          await context.store.put({ id: definition.key, partition: context.partition(), value: raw as T });
          await readView();
          emit({ fromCache: false });
        },
        { ifAvailable: false },
      );
    } catch (error) {
      if (!controller.signal.aborted) {
        // Cached data survives a failed refresh: showing something stale beats showing nothing,
        // and `status` says which it is.
        emit({ status: state.data === undefined ? 'error' : 'ready', error });
      }
    } finally {
      if (!controller.signal.aborted) emit({ refreshing: false });
    }
  }

  const unsubscribe = context.invalidator.subscribe(
    () => definition.tags ?? [],
    () => void fetchAndStore(true),
    { signal: controller.signal },
  );

  /**
   * Overlay changes recompute the view; they never refetch.
   *
   * A separate subscription rather than another tag on the one above, because the pending set moves
   * on every keystroke a user's edits generate and the record it applies to has not gone stale —
   * routing that through the fetch path would answer "someone typed" with a network request.
   */
  const unsubscribePending = context.invalidator.subscribe(
    () => [pendingTag(definition.key)],
    () => void readView(),
    { signal: controller.signal },
  );

  /**
   * Kick off: serve the cache when there is one, then decide whether to go to the network.
   *
   * A cache miss always fetches. A hit fetches only when revalidating — `staleWhileRevalidate:
   * false` means *do not go back to the network for something already held*, and an earlier version
   * of this had it backwards, force-refetching precisely when told not to. That is invisible when
   * every reader agrees about the data and very visible when they do not: the refetch overwrote a
   * record written by a newer app with the older reader's own shape.
   */
  void (async () => {
    const hit = await readView();
    if (!hit || staleWhileRevalidate) await fetchAndStore(hit);
  })();

  return {
    get current() {
      return state;
    },
    subscribe(listener) {
      listeners.add(listener);
      listener(state);
      return () => void listeners.delete(listener);
    },
    refetch: () => fetchAndStore(true),
    dispose() {
      controller.abort();
      unsubscribe();
      unsubscribePending();
      listeners.clear();
    },
  };
}

/**
 * Which of the patched fields the server did not agree with.
 *
 * Only the patched ones: a server that also touched `updatedAt` did not disagree with anybody, and
 * reporting that as a conflict would train users to dismiss the ones that matter.
 */
function disagreements(expected: unknown, actual: unknown, paths: readonly string[]): string[] {
  const from = (value: unknown) => (value ?? {}) as Record<string, unknown>;
  const before = from(expected);
  const after = from(actual);
  return paths.filter((path) => !same(before[path], after[path]));
}

/**
 * Structural equality, by serialization.
 *
 * Adequate because both sides came off the wire or out of an envelope moments ago — values that
 * survive JSON by construction. A deep-equality helper would be more code defending against inputs
 * this path cannot receive.
 */
function same(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}
