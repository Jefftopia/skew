/**
 * Cross-context mutual exclusion, for work that must happen once across every tab and realm.
 *
 * The motivating case is flushing the outbox. Storage is shared per origin, so without this every
 * open tab drains the same queue on reconnect — replaying the same mutations several times, against
 * a server that is by definition just coming back. No storage layer helps: IndexedDB makes each
 * *write* atomic, and says nothing about who should be doing the writing.
 *
 * `navigator.locks` is the only primitive that spans realms and tabs. Where it is missing — Node,
 * a non-secure context, an older browser — this degrades to an in-process lock, which is honest
 * about what it can offer: exclusion within one JavaScript context, which is what existed before
 * this and is still better than nothing.
 */

export type LockResult<T> = { acquired: true; value: T } | { acquired: false };

export interface LockOptions {
  /**
   * When true (the default), a lock already held elsewhere is **not waited for** — the call returns
   * `{ acquired: false }` immediately.
   *
   * Waiting is the wrong default for this. A flush that queued behind another tab's flush would run
   * against a queue that tab had just drained, so the work is redundant by the time it starts;
   * skipping says "someone is on it" and lets the caller move on.
   */
  ifAvailable?: boolean;
  signal?: AbortSignal;
}

/** True when this context has real cross-tab locks rather than the in-process fallback. */
export function hasCrossContextLocks(): boolean {
  return typeof navigator !== 'undefined' && navigator.locks !== undefined;
}

export async function withLock<T>(
  name: string,
  run: () => Promise<T>,
  options: LockOptions = {},
): Promise<LockResult<T>> {
  const ifAvailable = options.ifAvailable ?? true;

  if (!hasCrossContextLocks()) {
    return withInProcessLock(name, run, ifAvailable);
  }

  const request: LockOptions & { mode: LockMode } = { mode: 'exclusive', ifAvailable };
  if (options.signal) {
    // The spec forbids combining them: a request that is already declining to wait has nothing for
    // an abort signal to interrupt.
    delete (request as { ifAvailable?: boolean }).ifAvailable;
    (request as { signal?: AbortSignal }).signal = options.signal;
  }

  return navigator.locks.request(name, request as LockOptions, async (lock) => {
    // `ifAvailable` hands back a null lock rather than rejecting when someone else holds it.
    if (!lock) return { acquired: false } as LockResult<T>;
    return { acquired: true, value: await run() } as LockResult<T>;
  });
}

/**
 * Module-level so every holder in this JavaScript context shares it — two services in one Angular
 * app must exclude each other even when the platform gives us nothing.
 *
 * Per realm, though: realms are separate contexts, so this map is not shared between them. That is
 * precisely the gap `navigator.locks` closes, and the reason the fallback is a fallback.
 */
const inProcessLocks = new Map<string, Promise<unknown>>();

async function withInProcessLock<T>(
  name: string,
  run: () => Promise<T>,
  ifAvailable: boolean,
): Promise<LockResult<T>> {
  const held = inProcessLocks.get(name);

  if (held && ifAvailable) return { acquired: false };

  const release = (async () => {
    if (held) await held.catch(() => undefined);
    return run();
  })();

  // Stored before awaiting, so a synchronous second caller sees the lock as held.
  inProcessLocks.set(
    name,
    release.catch(() => undefined),
  );

  try {
    return { acquired: true, value: await release };
  } finally {
    // Only clear it if nobody queued behind us, or we would release someone else's turn.
    if (inProcessLocks.get(name) === undefined) inProcessLocks.delete(name);
    else if (!held) inProcessLocks.delete(name);
  }
}

/**
 * The lock name for flushing one owner's queue.
 *
 * Per **owner**, not one global lock. Two different applications flush disjoint entries, so making
 * them queue behind each other would serialize work that has no reason to be serialized. The
 * conflict this prevents is the same application open in two tabs, both replaying the same
 * mutations.
 */
export function outboxFlushLock(owner: string): string {
  return `skew:outbox:flush:${owner}`;
}
