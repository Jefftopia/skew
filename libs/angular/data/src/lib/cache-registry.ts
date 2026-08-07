import { Injectable } from '@angular/core';

/**
 * Tag-based invalidation.
 *
 * Tags rather than TTLs, because a time-to-live is a guess about when data went
 * stale, whereas a mutation *knows*. `bulletin#42` and `bulletins` are claims
 * about what a query depends on; invalidating a tag re-runs exactly the queries
 * that said they cared.
 *
 * Wildcards are supported in one direction only: invalidating `bulletin#*`
 * matches every `bulletin#…` subscriber. A subscriber may also register the
 * wildcard itself, in which case any invalidation of that type reaches it.
 */
@Injectable({ providedIn: 'root' })
export class CacheRegistry {
  private readonly subscribers = new Map<
    symbol,
    { readonly getTags: () => readonly string[]; readonly notify: () => void }
  >();

  /**
   * Registers interest in a set of tags. Returns a disposer.
   *
   * Tags are supplied as a getter and re-read on each invalidation, so a query
   * whose tags depend on signals (a route param, a filter) stays correct
   * without having to re-subscribe.
   */
  subscribe(getTags: () => readonly string[], notify: () => void): () => void {
    const token = Symbol('skew-cache-subscriber');
    this.subscribers.set(token, { getTags, notify });
    return () => void this.subscribers.delete(token);
  }

  /**
   * Marks tags stale, notifying every matching subscriber.
   *
   * Notification is synchronous but failure-isolated: one subscriber throwing
   * must not prevent the others from refreshing.
   */
  invalidate(...tags: readonly string[]): void {
    if (tags.length === 0) return;
    for (const subscriber of [...this.subscribers.values()]) {
      let interested = false;
      try {
        interested = subscriber.getTags().some((owned) => tags.some((t) => tagsMatch(owned, t)));
      } catch {
        // A tag getter that throws (a signal read outside its context, say)
        // must not take down invalidation for everyone else.
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

  /** Subscriber count. Diagnostics and tests only. */
  get size(): number {
    return this.subscribers.size;
  }
}

/**
 * `bulletin#*` matches `bulletin#42` in either position, so a mutation can
 * invalidate a whole type without enumerating ids, and a list query can
 * subscribe to a whole type without knowing which ids it will receive.
 */
export function tagsMatch(a: string, b: string): boolean {
  if (a === b) return true;
  const wildcardOf = (tag: string) => (tag.endsWith('#*') ? tag.slice(0, -1) : null);

  const aPrefix = wildcardOf(a);
  if (aPrefix && b.startsWith(aPrefix)) return true;

  const bPrefix = wildcardOf(b);
  if (bPrefix && a.startsWith(bPrefix)) return true;

  return false;
}
