import type { FragmentManifest } from '@braidlabs/gateway';
import type { SnapshotStore } from './store.js';
import type { RegistrySnapshot } from './snapshot.js';
import { verifySnapshot } from './snapshot.js';

export interface SnapshotRegistryOptions {
  /** Where published snapshots live. */
  store: SnapshotStore;
  /**
   * The snapshot to serve. Omit it to follow the store's `head` — convenient in development, and
   * the wrong choice in production, where a deploy should name the exact configuration it runs.
   */
  pinned?: string;
  /**
   * A second store, written through on every successful resolve and read from when the primary
   * store cannot be reached.
   *
   * For this to survive a restart it must be durable — a filesystem store on the instance's disk,
   * an image layer, a config volume. An in-memory cache is useless here: the failure it exists to
   * cover is a *cold* boot against an unreachable store, when nothing has been cached yet.
   */
  cache?: SnapshotStore;
  /**
   * What to do when the pinned snapshot cannot be resolved from the primary store.
   *
   * - `last-known-good` (default) — serve the cached copy, and report it.
   * - `fail` — throw. Correct when serving stale routing is worse than serving nothing.
   */
  fallback?: 'last-known-good' | 'fail';
  /**
   * Whether to recompute the content address and reject a snapshot whose id does not match its
   * content. Defaults to true.
   */
  verify?: boolean;
  /** Called with what happened, for logging. Never called on the request path — see below. */
  onDiagnostic?: (diagnostic: SnapshotDiagnostic) => void;
}

export interface SnapshotDiagnostic {
  level: 'info' | 'warn';
  event: 'resolved' | 'served-from-cache' | 'cache-write-failed' | 'head-followed';
  snapshotId?: string;
  message: string;
  cause?: unknown;
}

/**
 * A gateway `RegistrySource` backed by immutable snapshots.
 *
 * ```ts
 * createGateway({
 *   registry: snapshotRegistry({
 *     store,
 *     pinned: process.env.BRAID_REGISTRY_SNAPSHOT,
 *     cache: fileSnapshotStore({ directory: '/var/cache/braid' }),
 *   }),
 * });
 * ```
 *
 * **This runs once.** The gateway's `Registry` memoizes its source after the first load, so the
 * store is contacted during the first request that needs a manifest and never again. Two
 * consequences worth being explicit about:
 *
 * 1. The request path does not depend on the store's availability past boot, which is the point.
 * 2. Re-pinning takes effect on **restart**. That is the deliberate propagation the snapshot model
 *    asks for — a config change is a deploy, visible in whatever records deploys — but it does
 *    mean there is no hot re-pin, and adding one would require an invalidation hook on the
 *    gateway's `Registry`.
 */
export function snapshotRegistry(options: SnapshotRegistryOptions): () => Promise<FragmentManifest[]> {
  const { store, pinned, cache, fallback = 'last-known-good', verify = true, onDiagnostic } = options;

  return async () => {
    const snapshot = await resolve();
    return [...snapshot.manifests];
  };

  async function resolve(): Promise<RegistrySnapshot> {
    let id = pinned;
    let primaryError: unknown;

    try {
      if (!id) {
        id = (await store.head?.()) ?? undefined;
        if (!id) {
          throw new Error(
            'braid-registry: no snapshot pinned and the store reports no head — ' +
              'pass `pinned` with a snapshot id, or publish one first',
          );
        }
        report({ level: 'info', event: 'head-followed', snapshotId: id, message: `following store head ${id}` });
      }

      const snapshot = await store.get(id);
      if (!snapshot) throw new Error(`braid-registry: snapshot "${id}" is not in the store`);
      await assertIntact(snapshot);

      report({ level: 'info', event: 'resolved', snapshotId: id, message: `resolved snapshot ${id}` });
      void writeThrough(snapshot);
      return snapshot;
    } catch (error) {
      primaryError = error;
    }

    if (fallback === 'fail' || !cache || !id) throw primaryError;

    const cached = await cache.get(id).catch(() => null);
    if (!cached) throw primaryError;
    await assertIntact(cached);

    report({
      level: 'warn',
      event: 'served-from-cache',
      snapshotId: id,
      message: `the registry store is unreachable; serving snapshot ${id} from cache`,
      cause: primaryError,
    });
    return cached;
  }

  async function assertIntact(snapshot: RegistrySnapshot): Promise<void> {
    if (!verify) return;
    if (!(await verifySnapshot(snapshot))) {
      // Not staleness — a snapshot whose content does not match its id has been altered, and
      // serving it would quietly change which fragments compose which pages.
      throw new Error(
        `braid-registry: snapshot "${snapshot.id}" failed content verification — ` +
          'its manifests do not hash to its id, so it has been altered in storage or transit',
      );
    }
  }

  async function writeThrough(snapshot: RegistrySnapshot): Promise<void> {
    if (!cache) return;
    try {
      await cache.put(snapshot);
      await cache.setHead?.(snapshot.id);
    } catch (cause) {
      // A cache that cannot be written is a degraded fallback, not a failed boot.
      report({
        level: 'warn',
        event: 'cache-write-failed',
        snapshotId: snapshot.id,
        message: `could not write snapshot ${snapshot.id} to the local cache`,
        cause,
      });
    }
  }

  function report(diagnostic: SnapshotDiagnostic): void {
    onDiagnostic?.(diagnostic);
  }
}
