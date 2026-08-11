/**
 * Why a result type rather than exceptions or `null`.
 *
 * Reading versioned data has several distinct failure modes, and they demand
 * *different* remedies:
 *
 * - `ahead`   — the data was written by a newer build than the one reading it,
 *               and no down-migration path is available. Refetch, resolve the
 *               contract, or force the client to update.
 * - `gap`     — a migration step is missing from the chain. A programming error,
 *               and one that must be loud rather than silently dropping data.
 * - `invalid` — the payload does not match the shape its version claims, or the
 *               envelope belongs to a different contract entirely.
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
   * The version the data was written under when it was *older* than the
   * reader and was migrated forward. `null` when the data was already current
   * or was downgraded instead.
   */
  readonly migratedFrom: number | null;
  /**
   * The version the data was written under when it was *newer* than the
   * reader and was migrated **down** to the reader's version. `null` when the
   * data was current or older. A non-null value means `value` is an honest
   * but lossy projection — see {@link SkewOk.lossyPaths}.
   */
  readonly downgradedFrom: number | null;
  /**
   * Dot-paths whose values are the migration's *guesses* rather than data the
   * writer actually recorded — fields filled with defaults, placeholder
   * constants, or clock-derived values. Anything downstream that treats a
   * derived value as a reported one is trusting a guess; this list is how it
   * can tell.
   */
  readonly derivedPaths: readonly string[];
  /**
   * Dot-paths the newer shape carried that a down-migration had to discard.
   * Only ever non-empty when {@link SkewOk.downgradedFrom} is set.
   */
  readonly lossyPaths: readonly string[];
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

/** Optional success metadata — see the matching fields on {@link SkewOk}. */
export interface SkewOkMeta {
  readonly migratedFrom?: number | null;
  readonly downgradedFrom?: number | null;
  readonly derivedPaths?: readonly string[];
  readonly lossyPaths?: readonly string[];
}

const NO_PATHS: readonly string[] = Object.freeze([]);

export function ok<T>(value: T, meta: SkewOkMeta | number | null = null): SkewOk<T> {
  const normalized: SkewOkMeta = typeof meta === 'number' || meta === null ? { migratedFrom: meta } : meta;
  return {
    ok: true,
    value,
    migratedFrom: normalized.migratedFrom ?? null,
    downgradedFrom: normalized.downgradedFrom ?? null,
    derivedPaths: normalized.derivedPaths ?? NO_PATHS,
    lossyPaths: normalized.lossyPaths ?? NO_PATHS,
  };
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
 * Maps the success value, preserving all migration metadata.
 */
export function mapResult<T, U>(r: SkewResult<T>, fn: (value: T) => U): SkewResult<U> {
  return r.ok
    ? ok(fn(r.value), {
        migratedFrom: r.migratedFrom,
        downgradedFrom: r.downgradedFrom,
        derivedPaths: r.derivedPaths,
        lossyPaths: r.lossyPaths,
      })
    : r;
}
