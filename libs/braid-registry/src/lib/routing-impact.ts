import { Registry } from '@skewkit/braid-gateway';
import type { FragmentManifest } from '@skewkit/braid-gateway';
import type { ObservationSet } from './observations.js';

/**
 * What a registry change would do to traffic the gateway actually serves.
 *
 * The static checks answer "do these patterns overlap?". This answers "and does anyone go there?"
 * — which is the difference between a warning an operator has to judge and a number they can act
 * on. It is the one analysis in this package that is **not** decidable from the manifests alone,
 * which is exactly why it is optional and why it sits behind an observation hook that is off by
 * default.
 *
 * This is Apollo's schema-checks-against-observed-operations, applied to routing. That resemblance
 * is deliberate and fine: it is central by nature, optional in fact, and the honest way to answer
 * a question the manifests cannot.
 */

export interface PathImpact {
  pathname: string;
  /** Document requests observed for this path. */
  count: number;
  /** Fragment ids that stop composing here. */
  lost: string[];
  /** Fragment ids that start composing here. */
  gained: string[];
}

export interface FragmentImpact {
  fragmentId: string;
  lostPaths: number;
  lostRequests: number;
  gainedPaths: number;
  gainedRequests: number;
}

export interface RoutingImpact {
  /** Affected paths only, busiest first. */
  paths: PathImpact[];
  affectedPaths: number;
  /** Requests to affected paths — the number that says how much this matters. */
  affectedRequests: number;
  /** Per-fragment rollup. Usually the headline: "billing stops composing on 43 paths". */
  byFragment: FragmentImpact[];
  observed: { paths: number; requests: number; evicted: number; since: string };
  /**
   * True when observations were capped, so this reports a **sample**. Every summary built from
   * this must say so — a truncated dataset that reads as complete is worse than none.
   */
  sampled: boolean;
  unchanged: boolean;
}

/**
 * Computes routing impact by replaying observed paths through both registries.
 *
 * Matching goes through the gateway's own `Registry`, not a reimplementation. That matters more
 * here than it looks: pierce matching has a deliberate trailing-slash tolerance (`/checkout/*`
 * matches `/checkout`), and an analysis that missed it would report losses that will not happen.
 */
export async function routingImpact(
  observations: ObservationSet,
  before: readonly FragmentManifest[],
  after: readonly FragmentManifest[],
): Promise<RoutingImpact> {
  const beforeRegistry = new Registry(pierceable(before));
  const afterRegistry = new Registry(pierceable(after));

  const paths: PathImpact[] = [];
  const byFragment = new Map<string, FragmentImpact>();

  for (const observation of observations.paths) {
    const wasMatched = await matchedIds(beforeRegistry, observation.pathname);
    const nowMatched = await matchedIds(afterRegistry, observation.pathname);

    const lost = [...wasMatched].filter((id) => !nowMatched.has(id));
    const gained = [...nowMatched].filter((id) => !wasMatched.has(id));
    if (lost.length === 0 && gained.length === 0) continue;

    paths.push({ pathname: observation.pathname, count: observation.count, lost, gained });

    for (const fragmentId of lost) {
      const entry = rollup(byFragment, fragmentId);
      entry.lostPaths += 1;
      entry.lostRequests += observation.count;
    }
    for (const fragmentId of gained) {
      const entry = rollup(byFragment, fragmentId);
      entry.gainedPaths += 1;
      entry.gainedRequests += observation.count;
    }
  }

  paths.sort((a, b) => b.count - a.count);

  return {
    paths,
    affectedPaths: paths.length,
    affectedRequests: paths.reduce((sum, path) => sum + path.count, 0),
    byFragment: [...byFragment.values()].sort((a, b) => b.lostRequests - a.lostRequests),
    observed: {
      paths: observations.paths.length,
      requests: observations.totalRequests,
      evicted: observations.evicted,
      since: observations.since,
    },
    sampled: observations.evicted > 0,
    unchanged: paths.length === 0,
  };
}

/**
 * Reduces manifests to what pierce matching needs, dropping what it cannot use.
 *
 * A manifest with no id or endpoint serves nothing, so composing nothing is the correct answer for
 * it rather than a reason to throw — and an uncompilable pattern is `validateRegistry`'s finding to
 * report, not this function's to crash on. Filtering rather than fabricating keeps the result
 * honest: dropped entries genuinely do not compose.
 */
function pierceable(manifests: readonly FragmentManifest[]): FragmentManifest[] {
  return manifests
    .filter((manifest) => manifest.id && manifest.endpoint)
    .map((manifest) => ({
      ...manifest,
      pierce: (manifest.pierce ?? []).filter((pattern) => {
        try {
          new URLPattern({ pathname: pattern });
          return true;
        } catch {
          return false;
        }
      }),
    }));
}

async function matchedIds(registry: Registry, pathname: string): Promise<Set<string>> {
  return new Set((await registry.matchPierceRoutes(pathname)).map((manifest) => manifest.id));
}

function rollup(map: Map<string, FragmentImpact>, fragmentId: string): FragmentImpact {
  let entry = map.get(fragmentId);
  if (!entry) {
    entry = { fragmentId, lostPaths: 0, lostRequests: 0, gainedPaths: 0, gainedRequests: 0 };
    map.set(fragmentId, entry);
  }
  return entry;
}
