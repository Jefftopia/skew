import { loadRemoteModule } from '@angular-architects/native-federation';
import { lazy } from '@skew/angular-router';

/**
 * The federation boundary, wrapped so `@skew/angular-router` can see it.
 *
 * Native Federation resolves `remoteEntry.json` once, at page load, and caches
 * the hashed file names it contains for the lifetime of the tab. When the
 * remote is redeployed under a tab that is already open, those names are gone
 * from the origin — so the *first* time the user opens this route, a request
 * for a file that no longer exists 404s.
 *
 * That is the same failure as a purged lazy chunk, arriving from a different
 * direction, and it is exactly what `lazy()` exists to attribute.
 */

/**
 * Normalises the rejection into something `looksLikeChunkError()` recognises.
 *
 * A failed dynamic import does not have one shape. The browser, `es-module-shims`
 * (which Native Federation uses to polyfill import maps), and the fetch layer
 * each word it differently, and a `404` for an ES module sometimes surfaces as
 * a bare `TypeError` with no useful message at all. Rather than widen the
 * library's heuristic to cover a specific bundler, the adapter tags the error
 * at the point where we still know what was being attempted.
 */
function asChunkError(cause: unknown, remote: string, exposed: string): Error {
  const detail = cause instanceof Error ? cause.message : String(cause);
  const error = new Error(
    `Failed to fetch dynamically imported module: ${remote}${exposed} — ${detail}`,
  );
  error.name = 'ChunkLoadError';
  // `lib` is es2020 here, which predates `Error.cause` in the type definitions.
  // The original rejection is worth keeping — losing it makes a federation
  // failure indistinguishable from a network one in a bug report.
  (error as Error & { cause?: unknown }).cause = cause;
  return error;
}

/**
 * @param moduleId Logical id, echoed into the skew manifest. Without it there
 *   is no way to ask a new build "does this module still exist?", because by
 *   the time the import rejects all we hold is a hashed file name.
 */
export function loadRemote<T>(
  moduleId: string,
  remoteName: string,
  exposedModule: string,
  pick: (m: Record<string, unknown>) => T,
): () => Promise<T> {
  return lazy(moduleId, async () => {
    try {
      const module = await loadRemoteModule(remoteName, exposedModule);
      return pick(module as Record<string, unknown>);
    } catch (cause) {
      throw asChunkError(cause, remoteName, exposedModule);
    }
  });
}
