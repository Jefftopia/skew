/**
 * Build identity and skew negotiation.
 *
 * The premise: a deployed artifact needs a stable name so two independently
 * deployed parties can discover that they disagree. Everything else here —
 * stale chunks, contract mismatches, hydration failures — is a consequence of
 * that one missing primitive.
 */

/** Identity of the running client build, stamped at build time. */
export interface BuildIdentity {
  readonly buildId: string;
  /** ISO timestamp. Optional, but without it two builds cannot be *ordered*. */
  readonly builtAt?: string;
}

/**
 * The artifact an origin serves so clients can discover the current build.
 * Serve it with `Cache-Control: no-store`.
 */
export interface SkewManifest {
  readonly buildId: string;
  readonly builtAt?: string;
  /**
   * Optional logical-module → output-chunk map. Present, it lets a client
   * distinguish "this route moved" from "this route was deleted"; absent,
   * classification falls back to build identity alone.
   */
  readonly modules?: Readonly<Record<string, { readonly file: string; readonly hash?: string }>>;
}

/**
 * Outcome of comparing the running client against the origin.
 *
 * `staleOrigin` is the case naïve implementations miss, and the reason a plain
 * reload-on-error can brick a tab: if the origin is handing out an *older*
 * build than the one already running (a cached entry document, a lagging
 * region), reloading fetches the same stale bundle and fails again, forever.
 */
export type SkewStatus =
  | { readonly kind: 'current'; readonly buildId: string }
  | {
      /** A newer deployment exists. Reloading is safe and will resolve it. */
      readonly kind: 'staleClient';
      readonly local: string;
      readonly remote: string;
      readonly remoteBuiltAt?: string;
    }
  | {
      /** Origin is behind us — reloading would loop. Do not reload. */
      readonly kind: 'staleOrigin';
      readonly local: string;
      readonly remote: string;
    }
  | {
      /** Builds differ but cannot be ordered (no timestamps to compare). */
      readonly kind: 'differs';
      readonly local: string;
      readonly remote: string;
    }
  | {
      /** The origin could not be reached: offline, blocked, or timed out. */
      readonly kind: 'unreachable';
      readonly error: unknown;
    };

export interface VersionProbeOptions {
  /** Identity of this build. */
  readonly identity: BuildIdentity;
  /** URL of the manifest. Should be served `no-store`. */
  readonly manifestUrl: string;
  /** Injected for testing and for non-browser runtimes. */
  readonly fetch?: typeof globalThis.fetch;
  /** Abort the probe after this long. Default 5000ms. */
  readonly timeoutMs?: number;
  /**
   * Minimum gap between network probes; repeat calls inside the window reuse
   * the last answer. Default 10_000ms. Prevents a burst of chunk failures from
   * turning into a burst of manifest requests.
   */
  readonly minIntervalMs?: number;
}

export interface VersionProbe {
  /** Compares this build against the origin, subject to the interval cache. */
  check(): Promise<SkewStatus>;
  /** Last status observed, without touching the network. */
  last(): SkewStatus | null;
  /**
   * The manifest behind the last successful probe.
   *
   * Exposed because classification often needs the payload, not just the
   * verdict — `moduleWasRemoved()` is the motivating case, where "the route was
   * deleted" and "the chunk moved" demand different recovery.
   */
  lastManifest(): SkewManifest | null;
  /** Discards the cached answer so the next `check()` hits the network. */
  invalidate(): void;
}

/**
 * Creates a probe that answers "is this client still current?".
 *
 * ```ts
 * const probe = createVersionProbe({
 *   identity: { buildId: BUILD_ID, builtAt: BUILT_AT },
 *   manifestUrl: '/skew-manifest.json',
 * });
 *
 * const status = await probe.check();
 * if (status.kind === 'staleClient') offerReload();
 * if (status.kind === 'staleOrigin') doNotReload();  // would loop
 * ```
 */
export function createVersionProbe(options: VersionProbeOptions): VersionProbe {
  const {
    identity,
    manifestUrl,
    fetch: fetchImpl = globalThis.fetch?.bind(globalThis),
    timeoutMs = 5_000,
    minIntervalMs = 10_000,
  } = options;

  let cached: SkewStatus | null = null;
  let cachedManifest: SkewManifest | null = null;
  let cachedAt = 0;
  let inFlight: Promise<SkewStatus> | null = null;

  async function probe(): Promise<SkewStatus> {
    if (!fetchImpl) {
      return { kind: 'unreachable', error: new Error('no fetch implementation available') };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(manifestUrl, {
        cache: 'no-store',
        signal: controller.signal,
      });
      if (!response.ok) {
        return { kind: 'unreachable', error: new Error(`manifest responded ${response.status}`) };
      }
      const manifest = (await response.json()) as SkewManifest;
      cachedManifest = manifest;
      return compareBuilds(identity, manifest);
    } catch (error) {
      return { kind: 'unreachable', error };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async check(): Promise<SkewStatus> {
      const now = Date.now();
      if (cached && now - cachedAt < minIntervalMs) return cached;
      // Collapse concurrent callers onto one request — a page that fails to
      // load three chunks at once should still make a single probe.
      if (inFlight) return inFlight;

      inFlight = probe().then((status) => {
        cached = status;
        cachedAt = Date.now();
        inFlight = null;
        return status;
      });
      return inFlight;
    },
    last: () => cached,
    lastManifest: () => cachedManifest,
    invalidate: () => {
      cached = null;
      cachedManifest = null;
      cachedAt = 0;
    },
  };
}

/**
 * Pure comparison of a client identity against a manifest.
 *
 * Ordering requires timestamps on both sides. Without them the only honest
 * answer is `differs` — which callers should treat conservatively, because
 * they cannot rule out the reload-loop case.
 */
export function compareBuilds(identity: BuildIdentity, manifest: SkewManifest): SkewStatus {
  if (identity.buildId === manifest.buildId) {
    return { kind: 'current', buildId: manifest.buildId };
  }

  const localTime = parseTime(identity.builtAt);
  const remoteTime = parseTime(manifest.builtAt);

  if (localTime !== null && remoteTime !== null) {
    if (remoteTime > localTime) {
      return manifest.builtAt === undefined
        ? { kind: 'staleClient', local: identity.buildId, remote: manifest.buildId }
        : {
            kind: 'staleClient',
            local: identity.buildId,
            remote: manifest.buildId,
            remoteBuiltAt: manifest.builtAt,
          };
    }
    if (remoteTime < localTime) {
      return { kind: 'staleOrigin', local: identity.buildId, remote: manifest.buildId };
    }
  }

  return { kind: 'differs', local: identity.buildId, remote: manifest.buildId };
}

function parseTime(iso: string | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/** True when a module is absent from the manifest, i.e. deleted in the new build. */
export function moduleWasRemoved(manifest: SkewManifest, moduleId: string): boolean {
  return manifest.modules !== undefined && manifest.modules[moduleId] === undefined;
}
