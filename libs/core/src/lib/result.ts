/**
 * Why a result type rather than exceptions or `null`.
 *
 * Reading versioned data has several distinct failure modes, and they demand
 * *different* remedies:
 *
 * - `ahead`   — the data was written by a newer build than the one reading it.
 *               You cannot migrate downward; the information genuinely is not
 *               there. Refetch, or force the client to update.
 * - `gap`     — a migration step is missing from the chain. A programming error,
 *               and one that must be loud rather than silently dropping data.
 * - `invalid` — the payload does not match the shape its version claims.
 * - `threw`   — a migration function itself failed.
 *
 * Collapsing these into `null` (or a thrown `Error`) forces every caller to
 * guess, and the guess is usually "discard it" — which is data loss for the
 * `ahead` case, where the data is perfectly good and merely from the future.
 */

/** Discriminated failure reasons for a versioned read. */
export type SkewFailureReason = 'ahead' | 'gap' | 'invalid' | 'threw';

export interface SkewOk<T> {
  readonly ok: true;
  readonly value: T;
  /**
   * The version the stored data was written under, when it differed from the
   * current one. `null` when the data was already current.
   */
  readonly migratedFrom: number | null;
}

export interface SkewErr {
  readonly ok: false;
  readonly reason: SkewFailureReason;
  /** Version found on the data (0 when un-enveloped legacy data). */
  readonly found: number;
  /** Version the reader expected. */
  readonly expected: number;
  readonly message: string;
  readonly cause?: unknown;
}

export type SkewResult<T> = SkewOk<T> | SkewErr;

export function ok<T>(value: T, migratedFrom: number | null = null): SkewOk<T> {
  return { ok: true, value, migratedFrom };
}

export function err(
  reason: SkewFailureReason,
  found: number,
  expected: number,
  message: string,
  cause?: unknown,
): SkewErr {
  return { ok: false, reason, found, expected, message, cause };
}

/**
 * Narrowing helper, useful at call sites that only care about success.
 *
 * ```ts
 * if (isOk(result)) use(result.value);
 * ```
 */
export function isOk<T>(r: SkewResult<T>): r is SkewOk<T> {
  return r.ok;
}

export function isErr<T>(r: SkewResult<T>): r is SkewErr {
  return !r.ok;
}

/**
 * Unwraps a result, substituting a fallback on failure.
 *
 * Deliberately requires the fallback to be explicit — there is no `unwrap()`
 * that throws, because throwing on stale data is almost never what an
 * application wants at a read site.
 */
export function valueOr<T>(r: SkewResult<T>, fallback: T): T {
  return r.ok ? r.value : fallback;
}

/**
 * Maps the success value, leaving failures untouched.
 */
export function mapResult<T, U>(r: SkewResult<T>, fn: (value: T) => U): SkewResult<U> {
  return r.ok ? ok(fn(r.value), r.migratedFrom) : r;
}
