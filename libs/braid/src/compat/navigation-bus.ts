import { getBraidConfig } from '../config.js';

/**
 * Host navigation detection — without host patches, ever (invariant M0/D3).
 *
 * Fragment-initiated navigations are broadcast via a synthetic popstate event dispatched on the
 * main window — that mechanism mutates no host globals and is part of the observable contract
 * (the host application can react to fragment-driven URL changes through a regular popstate
 * listener).
 *
 * Host-initiated `pushState`/`replaceState` calls are detected through patch-free sources:
 *
 * 1. the `onHostNavigation` adapter from the library config: the host wires its router's
 *    after-navigation hook to our notify callback;
 * 2. the Navigation API's `currententrychange` event, where available. Traversals are ignored
 *    (covered natively by `popstate`), and fragment-initiated mutations are suppressed via
 *    {@link navigationBus.withFragmentNavigation} so they aren't double-reported.
 */

const hostNavigationSubscribers = new Set<() => void>();

/** True while a fragment-initiated history mutation is being applied. */
let fragmentNavigationInProgress = false;

/** True right after a host navigation was delivered, until the current microtask queue drains. */
let suppressDuplicateDetections = false;

/** The location as of the last delivered detection, used to tell duplicates from real moves. */
let lastDeliveredHref: string | undefined;

export const navigationBus = {
  /** Subscribes to host-initiated navigations. Returns an unsubscribe function. */
  subscribe(subscriber: () => void): () => void {
    hostNavigationSubscribers.add(subscriber);
    return () => hostNavigationSubscribers.delete(subscriber);
  },

  /**
   * Applies a fragment-initiated history mutation, suppressing the automatic host navigation
   * sources for its (synchronous) duration so the mutation isn't re-reported as a host
   * navigation.
   */
  withFragmentNavigation<T>(applyNavigation: () => T): T {
    fragmentNavigationInProgress = true;
    try {
      return applyNavigation();
    } finally {
      fragmentNavigationInProgress = false;
    }
  },

  /**
   * Reports a host-initiated navigation (from an adapter or an automatic source).
   *
   * The first detection is delivered to fragments synchronously (fragments must observe the new
   * location before the host performs any follow-up history operations — delayed delivery can
   * cancel pending history traversals in some browsers). Further detections of the same
   * navigation by other sources — e.g. the Navigation API firing synchronously during
   * `pushState` plus the host router calling the `onHostNavigation` notify callback right after
   * — are swallowed until the current microtask queue drains.
   *
   * Suppression is keyed on the location, not on time alone. Routers report navigation in
   * several phases, and the early ones fire *before* the URL changes: Angular's `NavigationStart`
   * is the common case. Time-only suppression would deliver that stale phase and then swallow
   * the one that actually moved the page, leaving fragments a navigation behind — so a detection
   * that finds a location we haven't delivered yet always gets through.
   */
  hostNavigationDetected(): void {
    if (fragmentNavigationInProgress) return;

    const href = typeof location === 'undefined' ? undefined : location.href;
    if (suppressDuplicateDetections && href === lastDeliveredHref) return;

    lastDeliveredHref = href;
    suppressDuplicateDetections = true;
    queueMicrotask(() => {
      suppressDuplicateDetections = false;
    });
    hostNavigationSubscribers.forEach((subscriber) => subscriber());
  },
};

let hostNavigationSourcesInstalled = false;

/** Installs the host navigation sources (idempotent). Neither source mutates any host global. */
export function ensureHostNavigationSources(): void {
  if (hostNavigationSourcesInstalled) return;
  hostNavigationSourcesInstalled = true;

  const { onHostNavigation } = getBraidConfig();
  onHostNavigation?.(() => navigationBus.hostNavigationDetected());

  const navigation = (window as any).navigation;
  if (navigation?.addEventListener) {
    navigation.addEventListener('currententrychange', (event: any) => {
      if (event?.navigationType === 'traverse') return;
      navigationBus.hostNavigationDetected();
    });
  }
}
