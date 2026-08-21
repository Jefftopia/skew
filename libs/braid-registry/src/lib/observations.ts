import type { RoutingEvent } from '@braid/gateway';

/**
 * Aggregated routing observations: which page paths a gateway actually serves, and what composes
 * into them.
 *
 * This is the substrate the traffic-informed half of impact analysis runs on, and it is
 * deliberately an **aggregate, not a log**. A log of every document request is unbounded, is a
 * retention liability, and answers no question this needs. What the analysis needs is the set of
 * distinct paths, how often each is served, and what currently composes there.
 *
 * The same three disciplines apply to any event sink on a request path, and the FDC3 audit sink
 * will want all of them: **bounded memory**, **redaction before storage**, and **never blocking
 * the request**.
 */

export interface PathObservation {
  pathname: string;
  /** Document requests seen for this path. */
  count: number;
  /** Fragment ids that composed here when last seen. */
  fragmentIds: string[];
  firstSeen: string;
  lastSeen: string;
}

export interface ObservationSet {
  paths: PathObservation[];
  /** Every document request counted, including those whose path was later evicted. */
  totalRequests: number;
  /**
   * Distinct paths dropped because the cap was reached.
   *
   * Non-zero means the analysis saw a **sample**, not the population, and every report built from
   * it says so. Silently truncated data that reads as complete is worse than no data.
   */
  evicted: number;
  since: string;
}

export interface RoutingObservationsOptions {
  /**
   * Distinct paths to retain. Defaults to 5000.
   *
   * Page paths are unbounded — `/orders/1`, `/orders/2`, … — so this is the memory ceiling, and
   * reaching it is normal rather than exceptional. Least-recently-seen paths are evicted first,
   * which keeps the retained sample weighted toward live traffic.
   */
  maxPaths?: number;
  /**
   * Rewrites or drops a path before it is stored. Return null to ignore the request entirely.
   *
   * **Paths carry identifiers, and sometimes personal ones** (`/users/ada@example.com`). Storing
   * them verbatim turns an analysis aid into a retention liability. Collapse the variable segments
   * you know about:
   *
   * ```ts
   * redact: (pathname) => pathname.replace(/\\/users\\/[^/]+/, '/users/:id')
   * ```
   *
   * Redacting to a pattern also collapses cardinality, which is the other reason to do it.
   */
  redact?: (pathname: string) => string | null;
  /** Clock, for tests. */
  now?: () => number;
}

export interface RoutingObservations {
  /** Records one event. Cheap, synchronous, and safe to call from the request path. */
  record(event: RoutingEvent): void;
  snapshot(): ObservationSet;
  clear(): void;
}

export function createRoutingObservations(options: RoutingObservationsOptions = {}): RoutingObservations {
  const maxPaths = Math.max(1, options.maxPaths ?? 5000);
  const now = options.now ?? Date.now;

  // Insertion order is recency order: re-observing a path deletes and re-sets it, so the oldest
  // key is always the least recently seen. That makes eviction O(1) with no bookkeeping.
  const paths = new Map<string, PathObservation>();
  let totalRequests = 0;
  let evicted = 0;
  let since = new Date(now()).toISOString();

  return {
    record(event: RoutingEvent): void {
      const pathname = options.redact ? options.redact(event.pathname) : event.pathname;
      if (pathname === null) return;

      totalRequests += 1;
      const at = new Date(event.at ?? now()).toISOString();
      const existing = paths.get(pathname);

      if (existing) {
        paths.delete(pathname);
        paths.set(pathname, {
          ...existing,
          count: existing.count + 1,
          // last write wins: what composes here is a property of the current registry, and the
          // most recent observation is the one that reflects it
          fragmentIds: event.fragmentIds,
          lastSeen: at,
        });
        return;
      }

      if (paths.size >= maxPaths) {
        const oldest = paths.keys().next().value;
        if (oldest !== undefined) {
          paths.delete(oldest);
          evicted += 1;
        }
      }

      paths.set(pathname, {
        pathname,
        count: 1,
        fragmentIds: event.fragmentIds,
        firstSeen: at,
        lastSeen: at,
      });
    },

    snapshot(): ObservationSet {
      return {
        // busiest first, so a truncated read still shows the paths that matter most
        paths: [...paths.values()].sort((a, b) => b.count - a.count),
        totalRequests,
        evicted,
        since,
      };
    },

    clear(): void {
      paths.clear();
      totalRequests = 0;
      evicted = 0;
      since = new Date(now()).toISOString();
    },
  };
}

export function serializeObservations(set: ObservationSet): string {
  return JSON.stringify(set, null, 2);
}

export function parseObservations(json: string): ObservationSet {
  const value = JSON.parse(json) as Partial<ObservationSet>;
  if (!Array.isArray(value?.paths)) {
    throw new Error('braid-registry: not an observation set — expected { paths: [...] }');
  }
  return {
    paths: value.paths,
    totalRequests: value.totalRequests ?? value.paths.reduce((sum, path) => sum + path.count, 0),
    evicted: value.evicted ?? 0,
    since: value.since ?? 'unknown',
  };
}
