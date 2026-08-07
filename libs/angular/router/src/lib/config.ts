import { InjectionToken } from '@angular/core';
import type { BuildIdentity } from '@skew/core';

/**
 * What to do when a lazy chunk cannot be loaded.
 *
 * These are not interchangeable. A missing chunk, an offline device, a deleted
 * route, and an origin serving a stale entry document all arrive as the same
 * rejected dynamic import, and each wants a different response — which is why
 * classification happens before dispatch.
 */
export type StaleChunkAction =
  /**
   * Hard-navigate to the URL the user was trying to reach.
   *
   * Distinct from a plain reload for a subtle reason: Angular's default
   * `urlUpdateStrategy` is `'deferred'`, so after a failed navigation the
   * address bar still shows the *previous* route. `location.reload()` would
   * therefore return the user where they started and silently discard the
   * navigation they attempted.
   */
  | 'reload-at-target'
  /** Refresh the current route, abandoning the attempted navigation. */
  | 'reload-in-place'
  /** Client-side redirect to `fallbackRoute`. Correct when the route is gone. */
  | 'redirect-to-fallback'
  /** Take no automatic action; expose it and let the application decide. */
  | 'notify'
  /** Leave `NavigationError` to propagate untouched. */
  | 'ignore';

/** Everything known about the failure at the moment a strategy is chosen. */
export interface StaleChunkContext {
  /** The URL the user was navigating to. */
  readonly targetUrl: string;
  /** Where they still are, since the navigation failed. */
  readonly currentUrl: string;
  /** Logical id passed to `lazy()`, when one was supplied. */
  readonly moduleId?: string;
  readonly error: unknown;

  /** Recoveries already spent this session, for loop protection. */
  readonly attempt: number;
  readonly isOnline: boolean;

  readonly clientBuildId: string;
  /** Present only when the manifest probe succeeded. */
  readonly serverBuildId?: string;

  /**
   * False when the module is absent from the new build's manifest — the route
   * was deleted, so reloading would land on a router 404.
   */
  readonly moduleStillExists: boolean;
  /**
   * True when the origin reports an *older* build than the one running.
   * Reloading fetches the same stale bundle and fails again — forever.
   */
  readonly entryDocumentStale: boolean;
  /** True when the probe reached the origin and it is ahead of us. */
  readonly newAssetsReachable: boolean;

  /** True when something on the page has registered unsaved work. */
  readonly hasUnsavedWork: boolean;
}

export type StaleChunkStrategy =
  | StaleChunkAction
  | ((context: StaleChunkContext) => StaleChunkAction | Promise<StaleChunkAction>);

export interface SkewRecoveryOptions {
  /** Identity of this build. Generate with `@skew/build`. */
  readonly identity: BuildIdentity;
  /**
   * Manifest the origin serves, `Cache-Control: no-store`. Without it the
   * library still recovers, but cannot distinguish a deleted route or a stale
   * origin — so it degrades to conservative behaviour.
   */
  readonly manifestUrl?: string;
  /** Default `'reload-at-target'`. */
  readonly onStaleChunk?: StaleChunkStrategy;
  /** Transient-failure retries inside `lazy()`. Default 1. */
  readonly retryAttempts?: number;
  /** Backoff between retries. Default 250ms. */
  readonly retryDelayMs?: number;
  /**
   * Hard cap on automatic recoveries per session. Default 1.
   *
   * The blunt guard against reload loops; the manifest probe is the precise
   * one. Both exist because the failure mode — a bricked tab — is severe.
   */
  readonly maxRecoveries?: number;
  /** Target for `'redirect-to-fallback'`. Default `'/'`. */
  readonly fallbackRoute?: string;
  /**
   * Degrade to `'notify'` when unsaved work is registered. Default true.
   *
   * Angular does not let a library ask the router whether a `CanDeactivate`
   * guard would block, so components opt in via `trackUnsavedWork()`.
   */
  readonly respectUnsavedWork?: boolean;
}

/** Fully-resolved options, with defaults applied. */
export interface ResolvedSkewRecoveryOptions extends SkewRecoveryOptions {
  readonly onStaleChunk: StaleChunkStrategy;
  readonly retryAttempts: number;
  readonly retryDelayMs: number;
  readonly maxRecoveries: number;
  readonly fallbackRoute: string;
  readonly respectUnsavedWork: boolean;
}

export const SKEW_RECOVERY_OPTIONS = new InjectionToken<ResolvedSkewRecoveryOptions>(
  'SKEW_RECOVERY_OPTIONS',
);

export function resolveOptions(options: SkewRecoveryOptions): ResolvedSkewRecoveryOptions {
  return {
    ...options,
    onStaleChunk: options.onStaleChunk ?? 'reload-at-target',
    retryAttempts: options.retryAttempts ?? 1,
    retryDelayMs: options.retryDelayMs ?? 250,
    maxRecoveries: options.maxRecoveries ?? 1,
    fallbackRoute: options.fallbackRoute ?? '/',
    respectUnsavedWork: options.respectUnsavedWork ?? true,
  };
}

/** A recovery the application has been asked to complete itself. */
export interface PendingSkew {
  readonly targetUrl: string;
  readonly moduleId?: string;
  readonly serverBuildId?: string;
  readonly reason: 'notify' | 'exhausted' | 'loop-detected' | 'offline';
  readonly context: StaleChunkContext;
}
