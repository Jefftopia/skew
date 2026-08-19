/**
 * Tag invalidation, across every app on the page and — when asked — every tab.
 *
 * Tags rather than TTLs, because a time-to-live is a guess about when data went stale whereas a
 * mutation *knows*. `character#1` and `characters` are claims about what a query depends on;
 * invalidating a tag re-runs exactly the queries that said they cared.
 *
 * The reach is the part that is new. A per-application registry gives each app its own private
 * answer, so a mutation in one leaves the other four stale — and staleness is invisible, which is
 * the worst property a bug can have.
 */

export interface InvalidationOptions {
  /**
   * Partition the signals belong to. Tags never cross one, so invalidating `characters` cannot
   * reach another tenant's queries.
   */
  partition: string;
  /**
   * Whether invalidation reaches other **JavaScript contexts** — other tabs, and other realms on
   * this page.
   *
   * Named for contexts rather than tabs because the two cases are the same mechanism and people
   * only think of the first one. A Braid realm is a separate context: two fragments composed onto
   * one page are as isolated from each other, in memory, as two tabs are. Leave this off on a
   * composed page and one fragment's invalidation silently never reaches another.
   *
   * Off by default, and that is a real choice rather than caution: refreshing a list in another tab
   * is sometimes exactly right and sometimes a refetch storm across five of them.
   */
  crossContext?: boolean;
  /** Injectable for tests. */
  channel?: BroadcastChannelLike;
}

/** The slice of `BroadcastChannel` this uses, so a test can supply a pair without a DOM. */
export interface BroadcastChannelLike {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  close(): void;
}

export interface Invalidator {
  /** Marks tags stale. Every subscriber that owns a matching tag is notified. */
  invalidate(...tags: string[]): void;
  /**
   * Registers interest. `getTags` is re-read on every invalidation, so a query whose tags depend on
   * a changing input stays correct without re-subscribing.
   */
  subscribe(getTags: () => readonly string[], notify: () => void, options?: { signal?: AbortSignal }): () => void;
  close(): void;
}

interface Signal {
  partition: string;
  tags: string[];
}

const CHANNEL_NAME = 'skew:data:invalidation';

/**
 * Invalidators, shared per partition within a JavaScript context.
 *
 * Two applications on one page each building a private invalidator is the same defect the outbox
 * had: a page-wide fact with a per-app answer. A mutation in one would leave the other stale, and
 * staleness is invisible — the worst property a bug can have.
 *
 * Cross-*realm* and cross-tab reach is `BroadcastChannel`'s job; this map covers the case the
 * channel cannot, which is two clients in one context (a channel does not deliver to its own
 * sender).
 */
const sharedInvalidators = new Map<string, { invalidator: Invalidator; refs: number }>();

/**
 * The invalidator for a partition, shared with anyone else who asks for the same one.
 *
 * Reference-counted: the underlying channel closes when the last holder closes, so a short-lived
 * client cannot take the page's invalidation down with it.
 */
export function sharedInvalidator(options: InvalidationOptions): Invalidator {
  const existing = sharedInvalidators.get(options.partition);
  if (existing) {
    existing.refs += 1;
    return wrapRelease(options.partition, existing.invalidator);
  }

  const entry = { invalidator: createInvalidator(options), refs: 1 };
  sharedInvalidators.set(options.partition, entry);
  return wrapRelease(options.partition, entry.invalidator);
}

function wrapRelease(partition: string, invalidator: Invalidator): Invalidator {
  let released = false;
  return {
    invalidate: (...tags) => invalidator.invalidate(...tags),
    subscribe: (getTags, notify, options) => invalidator.subscribe(getTags, notify, options),
    close() {
      if (released) return;
      released = true;

      const entry = sharedInvalidators.get(partition);
      if (!entry) return;
      entry.refs -= 1;
      if (entry.refs > 0) return;

      sharedInvalidators.delete(partition);
      entry.invalidator.close();
    },
  };
}

/** Exposed for tests. */
export function resetSharedInvalidators(): void {
  for (const entry of sharedInvalidators.values()) entry.invalidator.close();
  sharedInvalidators.clear();
}

export function createInvalidator(options: InvalidationOptions): Invalidator {
  const subscribers = new Map<symbol, { getTags: () => readonly string[]; notify: () => void }>();

  const channel =
    options.channel ??
    (options.crossContext && typeof BroadcastChannel !== 'undefined'
      ? (new BroadcastChannel(CHANNEL_NAME) as unknown as BroadcastChannelLike)
      : undefined);

  // A BroadcastChannel does not deliver to the context that posted, which is the semantics wanted
  // here: local subscribers are notified directly, remote ones over the channel, and neither path
  // double-fires.
  channel?.addEventListener('message', (event) => {
    const signal = event.data as Signal;
    if (signal?.partition !== options.partition) return;
    notifyLocal(signal.tags);
  });

  function notifyLocal(tags: readonly string[]): void {
    if (tags.length === 0) return;

    for (const subscriber of [...subscribers.values()]) {
      let interested = false;
      try {
        interested = subscriber.getTags().some((owned) => tags.some((tag) => tagsMatch(owned, tag)));
      } catch {
        // A tag getter that throws — a signal read outside its context, say — must not take down
        // invalidation for everyone else.
        interested = false;
      }
      if (!interested) continue;

      try {
        subscriber.notify();
      } catch {
        // A refresh that throws is that query's problem, not this loop's.
      }
    }
  }

  return {
    invalidate(...tags) {
      notifyLocal(tags);
      channel?.postMessage({ partition: options.partition, tags } satisfies Signal);
    },

    subscribe(getTags, notify, subscribeOptions) {
      const token = Symbol('skew-invalidation-subscriber');
      subscribers.set(token, { getTags, notify });

      const unsubscribe = () => void subscribers.delete(token);
      subscribeOptions?.signal?.addEventListener('abort', unsubscribe, { once: true });
      return unsubscribe;
    },

    close() {
      subscribers.clear();
      channel?.close();
    },
  };
}

/**
 * Wildcards in one direction: invalidating `character#*` reaches every `character#…` subscriber, and
 * a subscriber may register the wildcard itself to hear about any change to that type.
 */
function tagsMatch(owned: string, invalidated: string): boolean {
  if (owned === invalidated) return true;
  if (invalidated.endsWith('*')) return owned.startsWith(invalidated.slice(0, -1));
  if (owned.endsWith('*')) return invalidated.startsWith(owned.slice(0, -1));
  return false;
}
