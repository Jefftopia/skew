/**
 * Client-side reader for a mobile app PINNED AT v1 of portfolio-fund.
 *
 * The situation this file survives: the API now serves v2 bodies
 * (baseCurrency, liquidity.{cashPct,hqlaPct}) but this bundle shipped before
 * v2 existed, so no code-shipped migration chain in it can possibly read the
 * newer shape — the knowledge wasn't written yet. That is the `ahead` case,
 * and the cure is data, not code: fetch the origin's published contract
 * document, learn the v1→v2 step it declares, and run that step's known
 * inverse to project the v2 body down to v1.
 *
 * WHAT THE v1 PROJECTION LOSES (labeled, not silent):
 *   - liquidity.hqlaPct  — LOST. The inverse of `default` removes the field
 *     and v1 has nowhere to carry it. It is reported in `result.lossyPaths`;
 *     nothing is guessed, so `derivedPaths` is empty for this step.
 *   - baseCurrency -> currency          — lossless (inverse of `rename`).
 *   - liquidity.cashPct -> cashPct      — lossless (inverse of `move`).
 *
 * The frozen types and bundled contract come from the same generated file the
 * server uses (skew-contract gen); this v1 build simply carries the copy that
 * existed when it shipped. That's fine: `readResolving` fetches the origin's
 * live document (ETag-revalidated, cached) whenever the local chain comes up
 * `ahead`.
 */
import {
  createContractResolver,
  versionedFromContract,
  wellKnownContractUrl,
} from '@braidlabs/contract';
import { parseSkewContractHeader, SKEW_CONTRACT_HEADER } from '@braidlabs/skew';
import {
  FundV1,
  PORTFOLIO_FUND_CONTRACT,
} from './generated/portfolio-fund.contract';

const API_BASE = 'https://api.example.com';

// Pinned at 1: reads produce the v1 shape this bundle was compiled against.
// Newer steps learned from the origin's contract feed the shared schema
// registry, which read() consults to downgrade newer data.
const FundSchemaV1 = versionedFromContract<FundV1>(PORTFOLIO_FUND_CONTRACT, {
  at: 1,
});

// One resolver for the app; it caches fetched contracts with ETag
// revalidation, so curing `ahead` costs one contract fetch, then 304s.
const resolver = createContractResolver();

export interface FundReadOutcome {
  fund: FundV1 | null;
  /** True when the body was newer than v1 and was downgraded via contract. */
  downgraded: boolean;
  /** Dot-paths the v1 projection could not carry, e.g. ['liquidity.hqlaPct']. */
  lost: readonly string[];
}

export async function fetchFundAsV1(id: string): Promise<FundReadOutcome> {
  const res = await fetch(`${API_BASE}/portfolio-funds/${id}`);
  const body: unknown = await res.json();

  // Discover the contract URL from the response's skew-contract header when
  // present; fall back to the well-known location. No hardcoded paths.
  const header = res.headers.get(SKEW_CONTRACT_HEADER);
  const contractUrl =
    (header ? parseSkewContractHeader(header)?.url : undefined) ??
    wellKnownContractUrl(API_BASE, 'portfolio-fund');

  // Reads exactly like FundSchemaV1.read(body); the difference only appears
  // on `ahead`: fetch the contract, learn the newer steps, and return an
  // honest, labeled, lossy downgrade instead of a failure.
  const result = await resolver.readResolving(FundSchemaV1, body, contractUrl);

  if (result.ok) {
    if (result.downgradedFrom) {
      // v2 body read by a v1 build — honest and labeled. For this contract:
      //   lossyPaths === ['liquidity.hqlaPct']  (v1 cannot carry it)
      // Surface it (telemetry / a "limited data" badge), never hide it: any
      // screen that would have shown HQLA must render "unavailable", and this
      // client must not round-trip a write of the projected fund without the
      // server merging (it would otherwise erase hqlaPct for everyone).
      console.info(
        `portfolio-fund ${id}: downgraded v${result.downgradedFrom} -> v1;` +
          ` lost: ${result.lossyPaths.join(', ') || '(nothing)'}`,
      );
      return { fund: result.value, downgraded: true, lost: result.lossyPaths };
    }
    // Body was v1 (or older and migrated up): full fidelity.
    return { fund: result.value, downgraded: false, lost: [] };
  }

  // Results, not values: each reason needs a different remedy. Never collapse
  // this to `null` at the boundary — and NEVER discard on `ahead`.
  switch (result.reason) {
    case 'ahead':
      // Still ahead even after resolving — the contract fetch failed (offline,
      // blocked) or the origin no longer publishes it. The data is GOOD data
      // from the future: keep any cached copy untouched and retry later.
      scheduleRetry(id);
      return { fund: null, downgraded: false, lost: [] };
    case 'gap':
      // The contract declares a named `code` step this bundle doesn't ship in
      // its codeSteps. Loud degradation, never a guess — report it; the fix
      // ships server-side (avoid code steps) or in an app update.
      reportBug('portfolio-fund contract has a code step this build lacks', result);
      return { fund: null, downgraded: false, lost: [] };
    case 'invalid':
      // Not an envelope / malformed body: safe to discard and refetch.
      return { fund: null, downgraded: false, lost: [] };
    case 'threw':
      // A migration step threw — a bug in the contract or interpreter.
      reportBug('portfolio-fund migration threw', result);
      return { fund: null, downgraded: false, lost: [] };
  }
}

// --- app-specific stubs -----------------------------------------------------
declare function scheduleRetry(id: string): void;
declare function reportBug(message: string, detail: unknown): void;
