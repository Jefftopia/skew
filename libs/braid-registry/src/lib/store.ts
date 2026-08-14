import type { RegistrySnapshot } from './snapshot.js';

/**
 * Where snapshots live.
 *
 * Deliberately tiny, and deliberately not a database interface: a snapshot is an immutable
 * document addressed by id, so the only operations that exist are put, get, and enumerate. There
 * is no update and no delete-by-mutation, because there is nothing to mutate.
 *
 * `head` is the one piece of mutable state — the pointer to what was published most recently.
 * Implementations may omit it, in which case callers must pin explicitly.
 */
export interface SnapshotStore {
  get(id: string): Promise<RegistrySnapshot | null>;
  /**
   * Stores a snapshot. Storing an id that already exists is a no-op rather than an error: the
   * content is identical by construction, so a second publish of the same config is not a
   * conflict.
   */
  put(snapshot: RegistrySnapshot): Promise<void>;
  /** Snapshot references, newest first. */
  list(options?: { limit?: number }): Promise<SnapshotRef[]>;
  /** The most recently published snapshot id, when the store tracks one. */
  head?(): Promise<string | null>;
  setHead?(id: string): Promise<void>;
}

export interface SnapshotRef {
  id: string;
  createdAt: string;
  fragmentCount: number;
  labels?: Readonly<Record<string, string>>;
}

export function toRef(snapshot: RegistrySnapshot): SnapshotRef {
  return {
    id: snapshot.id,
    createdAt: snapshot.createdAt,
    fragmentCount: snapshot.manifests.length,
    ...(snapshot.labels ? { labels: snapshot.labels } : {}),
  };
}

/**
 * An in-memory store. Useful in tests, in development, and as the cache tier in front of a remote
 * store — it is not durable, so it is never the right primary store for a deployed gateway.
 */
export function memorySnapshotStore(seed: readonly RegistrySnapshot[] = []): SnapshotStore {
  const snapshots = new Map<string, RegistrySnapshot>();
  let head: string | null = null;

  for (const snapshot of seed) {
    snapshots.set(snapshot.id, snapshot);
    head = snapshot.id;
  }

  return {
    async get(id) {
      return snapshots.get(id) ?? null;
    },
    async put(snapshot) {
      snapshots.set(snapshot.id, snapshot);
    },
    async list({ limit } = {}) {
      const refs = [...snapshots.values()]
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
        .map(toRef);
      return limit === undefined ? refs : refs.slice(0, limit);
    },
    async head() {
      return head;
    },
    async setHead(id) {
      if (!snapshots.has(id)) {
        throw new Error(`braid-registry: cannot point head at unknown snapshot "${id}"`);
      }
      head = id;
    },
  };
}
