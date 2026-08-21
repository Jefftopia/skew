import { versioned } from '@braidlabs/skew';
import { createContractResolver, wellKnownContractUrl } from '@braidlabs/contract';

/**
 * The host's view of the portfolio contract — v1 only. It has never heard of
 * v2 and never will; that ignorance is the point of the demo.
 *
 * Duplicated in `apps/prod-remote/src/app/portfolio/contracts.ts` rather than
 * shared, for the same reason `domain.ts` is duplicated: a shared library
 * would make the two apps one deployment and delete the skew this demo exists
 * to show. What they actually share is the wire format — the API's `{ v,
 * payload }` envelopes and the WebSocket/SSE frame shapes — not the code.
 */

export interface HoldingV1 {
  ticker: string;
  name: string;
  weightPct: number;
  marketValue: number;
}

export interface FundV1 {
  id: string;
  name: string;
  currency: string;
  nav: number;
  cashPct: number;
  holdings: HoldingV1[];
}

/** Matches the API's `/api/v1/funds` envelope: `{ v: 1, payload: FundV1[] }`. */
export const FundListSchemaV1 = versioned<FundV1[]>('portfolio-funds');

/**
 * A single fund's envelope — what the host writes to `sessionStorage` under
 * `SELECTED_FUND_KEY` before navigating to the remote's fund detail. Same
 * schema name (`'portfolio-fund'`, singular) as the remote's `FundSchemaV2`
 * base — that name match is what lets the remote's migration recognise and
 * upgrade what the host wrote.
 */
export const FundSchemaV1 = versioned<FundV1>('portfolio-fund');

/** Key the host writes the selected fund's v1 record under before navigating. */
export const SELECTED_FUND_KEY = 'portfolio:selected-fund';

export interface OrderV1 {
  fundId: string;
  action: 'raise-cash' | 'sell-holding' | 'defer-redemption';
  ticker?: string;
  amount: number;
  note?: string;
}

export const OrderSchemaV1 = versioned<OrderV1>('portfolio-order');

export interface LiquidityBreachV1 {
  id: string;
  at: string;
  severity: 'warning' | 'breach';
  trigger: {
    kind: 'order' | 'adjustment' | 'transaction';
    ref: string;
    description: string;
    amount: number;
  };
  /** The instrument the event is about — always held by every fund. */
  ticker: string;
  impacted: Array<{
    fundId: string;
    fundName: string;
    weightPct: number;
    cashPctBefore: number;
    cashPctAfter: number;
    thresholdPct: number;
  }>;
  suggestedAction: {
    kind: 'raise-cash' | 'sell-holding' | 'defer-redemption';
    ticker: string;
    amount: number;
    rationale: string;
  };
}

export const BreachSchemaV1 = versioned<LiquidityBreachV1>('liquidity-breach');

export interface TickImpactedFund {
  fundId: string;
  fundName: string;
  weightPct: number;
  navImpactPct: number;
}

export interface TickV1 {
  ticker: string;
  name: string;
  price: number;
  changePct: number;
  direction: 'up' | 'down' | 'flat';
  at: string;
  impactedFunds: TickImpactedFund[];
}

export const TickSchemaV1 = versioned<TickV1>('ticker-tick');

/**
 * Where the mock portfolio API is reachable, decided at runtime by which port
 * this bundle was loaded from — the same static build serves both modes.
 *
 * Two-port mode (`:4410`/`:4411`, from `demo:prod:serve`) has no proxy in
 * front of it, so the API has to be addressed directly on `:3333`.
 * Same-origin mode (`demo:prod:same-origin`, any other port) does have one —
 * `tools/serve-same-origin.mjs` forwards `/api/*` and `/ws/ticker` to the same
 * API process — so a relative path is not just possible there, it is the
 * whole point: it is what lets `localStorage` and cookies work across the
 * federation boundary in that mode.
 */
const DIRECT_PORTS = new Set(['4410', '4411']);

function isDirectMode(): boolean {
  return DIRECT_PORTS.has(globalThis.location?.port ?? '');
}

export const API_BASE = isDirectMode() ? 'http://localhost:3333/api' : '/api';
export const WS_TICKER_URL = isDirectMode()
  ? 'ws://localhost:3333/ws/ticker'
  : `ws://${globalThis.location?.host}/ws/ticker`;

/**
 * Where the API publishes the fund contract document. This build understands
 * v1 and nothing newer — that ignorance is still the point — but it *does*
 * know where the contract lives. The day a response arrives from the future,
 * the resolver fetches this document, learns the newer steps (including their
 * down direction), and this host reads an honest projection instead of
 * dead-ending at `ahead`. No redeploy of this app involved.
 */
export const FUND_CONTRACT_URL = wellKnownContractUrl(API_BASE, 'portfolio-fund');

export const fundContractResolver = createContractResolver({
  // The API publishes the *item* contract; this host reads the collection
  // through its own list schema. The mapping lifts one to the other.
  lists: { 'portfolio-fund': 'portfolio-funds' },
});
