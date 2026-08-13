/**
 * Library-wide configuration for the Braid client runtime, set via `initBraid(options)`.
 *
 * Note there is no host-isolation mode switch: host purity is an invariant, not a mode (D3).
 * Braid never mutates a host-page global or prototype — in any mode, ever. The compat adapter
 * achieves its interception with fragment-boundary techniques confined to each fragment's own
 * realm and shadow DOM subtree.
 */

export interface BraidOptions {
  /**
   * Enables development-mode diagnostics: unaudited-API warnings from the compat document
   * facade, boundary-bypass reports, and verbose boot logging. Defaults to false.
   */
  dev?: boolean;

  /**
   * Host navigation adapter. Bound fragments need to know when the host application navigates
   * (e.g. the host router calls `history.pushState`). Braid never patches the host History API,
   * so wire your router's after-navigation hook to the provided `notify` callback:
   *
   * ```ts
   * initBraid({ onHostNavigation: (notify) => router.afterEach(() => notify()) });
   * ```
   *
   * Where the Navigation API is available, host navigations are additionally observed
   * automatically. Back/forward navigations (`popstate`) are always observed natively and need
   * no adapter.
   */
  onHostNavigation?: (notify: () => void) => void;
}

interface ResolvedBraidConfig {
  dev: boolean;
  onHostNavigation?: (notify: () => void) => void;
}

const config: ResolvedBraidConfig = {
  dev: false,
};

export function setBraidConfig(options: BraidOptions = {}): void {
  if (options.dev !== undefined) {
    config.dev = options.dev;
  }
  if (options.onHostNavigation) {
    config.onHostNavigation = options.onHostNavigation;
  }
}

export function getBraidConfig(): Readonly<ResolvedBraidConfig> {
  return config;
}

export function isDevMode(): boolean {
  return config.dev;
}
