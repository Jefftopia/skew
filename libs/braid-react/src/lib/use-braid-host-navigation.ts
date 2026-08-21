import { useEffect, useRef } from 'react';
import { initBraid, type BraidOptions } from '@braidlabs/core';

/**
 * Tells Braid when the host application has navigated, so *bound* fragments follow along.
 *
 * Braid never patches the host's History API — host purity is an invariant — so bound fragments
 * learn about host navigation through a callback. React has no single router, so rather than
 * couple to one, pass anything that changes once per navigation:
 *
 * ```tsx
 * useBraidHostNavigation(useLocation().key);                                  // react-router
 * useBraidHostNavigation(useRouterState({ select: (s) => s.location.href })); // TanStack Router
 * ```
 *
 * The notification fires from an effect, which runs *after* commit — and after-navigation is the
 * only correct moment. Signalling before the URL changes tells fragments about a location the
 * page has not reached, leaving them a navigation behind.
 */
export function useBraidHostNavigation(locationKey: string | number): void {
  const notifiers = useNotifiers();
  const previous = useRef(locationKey);

  useEffect(() => {
    if (previous.current === locationKey) return; // the initial render is not a navigation
    previous.current = locationKey;
    notifiers.current.forEach((notify) => notify());
  }, [locationKey, notifiers]);
}

/**
 * Braid asks for host navigation sources lazily — the first time a bound fragment boots — which
 * may be before or after the hook mounts. Collecting the callbacks in a module-level set makes
 * the ordering irrelevant.
 */
const hostNavigationNotifiers = new Set<() => void>();
let registered = false;

function useNotifiers() {
  const ref = useRef(hostNavigationNotifiers);
  return ref;
}

/**
 * Initializes the Braid client for a React host.
 *
 * Call it once, at module scope in your entry file, before anything renders a fragment. It is
 * `initBraid` with the host-navigation plumbing already wired to
 * {@link useBraidHostNavigation}.
 */
export function initBraidReact(options: BraidOptions = {}): void {
  initBraid({
    ...options,
    onHostNavigation: (notify) => {
      options.onHostNavigation?.(notify);
      hostNavigationNotifiers.add(notify);
      registered = true;
    },
  });
}

/** Exposed for tests: whether Braid has asked for host navigation sources yet. */
export function hasHostNavigationSources(): boolean {
  return registered;
}
