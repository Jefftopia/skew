/**
 * Wrapping the dynamic import.
 *
 * Two problems are solved here, both before any Angular machinery is involved:
 *
 * 1. **Attribution.** By the time an import rejects, the runtime holds
 *    `chunk-ABC123.js` — not `./admin/routes`. Without a logical id there is no
 *    way to ask the new build's manifest whether that route still exists.
 * 2. **Transience.** A flaky network, a CDN edge miss, and a genuinely purged
 *    asset are indistinguishable from the error alone. A bounded retry resolves
 *    the first two without inflicting a page reload on anyone.
 *
 * Retry is therefore a *precondition* to recovery, not one of the strategies.
 */

import { isSkewDisabled } from '@skewkit/core';

/** Defaults for `lazy()`, overridable globally by `provideSkewRecovery()`. */
export const lazyDefaults = {
  retryAttempts: 1,
  retryDelayMs: 250,
};

/** Restores defaults. Exposed for tests, which must not leak configuration. */
export function resetLazyDefaults(): void {
  lazyDefaults.retryAttempts = 1;
  lazyDefaults.retryDelayMs = 250;
}

/**
 * Thrown when a lazy load fails after its retries are exhausted.
 *
 * Angular surfaces this through `NavigationError`, where the recovery service
 * recognises it. Carrying the module id across that boundary is the whole
 * reason this error type exists.
 */
export class ChunkLoadFailure extends Error {
  override readonly name = 'ChunkLoadFailure';
  constructor(
    readonly moduleId: string | undefined,
    readonly cause: unknown,
    readonly attempts: number,
  ) {
    super(
      `[skew] failed to load ${moduleId ? `"${moduleId}"` : 'a lazy chunk'} ` +
        `after ${attempts} attempt${attempts === 1 ? '' : 's'}`,
    );
  }
}

export function isChunkLoadFailure(value: unknown): value is ChunkLoadFailure {
  return value instanceof ChunkLoadFailure;
}

/**
 * Heuristic for "this looks like a module that failed to load" rather than an
 * error thrown *by* the module once it ran.
 *
 * Deliberately broad: bundlers and browsers disagree on the shape here
 * (`ChunkLoadError`, a bare `TypeError`, a CSP violation), and a false positive
 * costs one wasted retry while a false negative costs the user their session.
 */
export function looksLikeChunkError(error: unknown): boolean {
  if (!error) return false;
  const name = (error as Error).name ?? '';
  const message = (error as Error).message ?? '';
  return (
    name === 'ChunkLoadError' ||
    /loading (chunk|css chunk)/i.test(message) ||
    /failed to fetch dynamically imported module/i.test(message) ||
    /error loading dynamically imported module/i.test(message) ||
    /importing a module script failed/i.test(message)
  );
}

export interface LazyOptions {
  readonly retryAttempts?: number;
  readonly retryDelayMs?: number;
}

/**
 * Wraps a dynamic import for use as `loadChildren` or `loadComponent`.
 *
 * ```ts
 * { path: 'admin', loadChildren: lazy('admin.routes', () => import('./admin/routes')) }
 * { path: 'help',  loadComponent: lazy('help.page', () => import('./help').then(m => m.Help)) }
 * ```
 *
 * The returned function is a plain loader — the router needs no knowledge of
 * this library, and routes remain usable if the package is removed.
 */
export function lazy<T>(
  moduleId: string,
  loader: () => Promise<T>,
  options?: LazyOptions,
): () => Promise<T>;
export function lazy<T>(loader: () => Promise<T>, options?: LazyOptions): () => Promise<T>;
export function lazy<T>(
  moduleIdOrLoader: string | (() => Promise<T>),
  loaderOrOptions?: (() => Promise<T>) | LazyOptions,
  maybeOptions?: LazyOptions,
): () => Promise<T> {
  const hasId = typeof moduleIdOrLoader === 'string';
  const moduleId = hasId ? moduleIdOrLoader : undefined;
  const loader = (hasId ? loaderOrOptions : moduleIdOrLoader) as () => Promise<T>;
  const options = (hasId ? maybeOptions : (loaderOrOptions as LazyOptions)) ?? {};

  if (typeof loader !== 'function') {
    throw new TypeError('[skew] lazy() requires a loader function');
  }

  return async () => {
    // Not public API — see `disabled.ts` in @skewkit/core. A bare dynamic import
    // with no retry and no attribution: the rejection propagates exactly as the
    // bundler produced it, and nothing downstream knows which module it was.
    if (isSkewDisabled()) return loader();

    const attempts = Math.max(0, options.retryAttempts ?? lazyDefaults.retryAttempts) + 1;
    const delay = options.retryDelayMs ?? lazyDefaults.retryDelayMs;

    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await loader();
      } catch (error) {
        lastError = error;
        // An error thrown by module *evaluation* is a bug in the module, not a
        // transport failure. Retrying it just runs the bug again.
        if (!looksLikeChunkError(error)) throw error;
        if (attempt < attempts && delay > 0) {
          await new Promise((resolve) => setTimeout(resolve, delay * attempt));
        }
      }
    }
    throw new ChunkLoadFailure(moduleId, lastError, attempts);
  };
}
