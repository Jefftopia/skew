import { MigrationContext, registerSchema, versioned, versionedList } from '@braid/skew';

/**
 * The remote's view of the same portfolio contract — a near-copy of the
 * host's `contracts.ts`, and the duplication is deliberate; see the note
 * there.
 *
 * The remote is the NEWER party here too: it understands fund schema v2,
 * which the API also serves (`/api/v2/funds`) so a v2 record can be fetched
 * *authoritatively* rather than only reached by migrating a v1 one — the
 * three-way reconciliation in `fund-detail.ts` depends on having both.
 */

// --- funds -------------------------------------------------------------

/** v1, frozen as the remote received it. Never edited again. */
interface HoldingV1 {
  ticker: string;
  name: string;
  weightPct: number;
  marketValue: number;
}

/** v1, frozen as the remote received it. Never edited again. */
interface FundV1 {
  id: string;
  name: string;
  currency: string;
  nav: number;
  cashPct: number;
  holdings: HoldingV1[];
}

export interface HoldingV2 {
  ticker: string;
  name: string;
  weightPct: number;
  marketValue: { amount: number; currency: string };
  /** Not derivable from v1 data — see the migration below. */
  liquidityTier: 'T1' | 'T2' | 'T3';
}

export interface FundV2 {
  id: string;
  name: string;
  baseCurrency: string;
  nav: { amount: number; asOf: string };
  liquidity: {
    cashPct: number;
    hqlaPct: number;
    redemptionCoverDays: number;
  };
  classification: { assetClass: string; strategy: string };
  holdings: HoldingV2[];
}

/**
 * The pure v1 → v2 mapping, shared by the single-fund and list schemas below
 * so the two migrations cannot silently drift apart.
 *
 * Three kinds of change, and only two of them are honest guesses. `baseCurrency`
 * is a rename — exact. `nav.amount` and `holdings[].marketValue` are v1's
 * scalars promoted into structure — exact, modulo `nav.asOf` which can only be
 * "now" (the migration's run time), not the true as-of date the server would
 * know.
 *
 * `liquidity.hqlaPct`, `liquidity.redemptionCoverDays`, `classification`, and
 * every holding's `liquidityTier` are fields v1 never carried at all. There is
 * no honest value to migrate them to, so they are filled with a value that is
 * *visibly* a placeholder (`0`, `'unknown'`, `'T2'`) rather than a plausible
 * fake — the fund-detail view's reconciliation against `/api/v2/funds` is what
 * replaces the guess with the truth, and a plausible-looking guess would make
 * that gap invisible instead of visible.
 */
function migrateFundV1ToV2(v1: FundV1, ctx: MigrationContext): FundV2 {
  return {
    id: v1.id,
    name: v1.name,
    baseCurrency: v1.currency,
    // The clock comes from the context, never from `new Date()` inside the
    // migration — same input, same output, or replays and tests both lie.
    nav: { amount: v1.nav, asOf: ctx.now().toISOString() },
    liquidity: {
      cashPct: v1.cashPct,
      hqlaPct: 0, // derived — unknown until reconciled against the server
      redemptionCoverDays: 0, // derived — unknown until reconciled against the server
    },
    classification: { assetClass: 'unknown', strategy: 'unknown' }, // derived
    holdings: v1.holdings.map((h) => ({
      ticker: h.ticker,
      name: h.name,
      weightPct: h.weightPct,
      marketValue: { amount: h.marketValue, currency: v1.currency },
      liquidityTier: 'T2', // derived — a guess, not a report
    })),
  };
}

/**
 * The reverse projection — what a v1-only reader should see of a v2 record.
 * Lossy on purpose: the fields it discards are exactly the ones v1 cannot
 * carry, and `lossy` in the step below names them so no reader mistakes the
 * projection for the whole record.
 */
function migrateFundV2ToV1(v2: FundV2): FundV1 {
  return {
    id: v2.id,
    name: v2.name,
    currency: v2.baseCurrency,
    nav: v2.nav.amount,
    cashPct: v2.liquidity.cashPct,
    holdings: v2.holdings.map((h) => ({
      ticker: h.ticker,
      name: h.name,
      weightPct: h.weightPct,
      marketValue: h.marketValue.amount,
    })),
  };
}

const FUND_V2_GUESSED_FIELDS = [
  'nav.asOf',
  'liquidity.hqlaPct',
  'liquidity.redemptionCoverDays',
  'classification',
  'holdings[].liquidityTier',
] as const;

export const FundSchemaV2 = versioned<FundV1>('portfolio-fund').next<FundV2>(
  'promote scalars to structure; add liquidity and classification fields v1 never carried',
  {
    up: migrateFundV1ToV2,
    down: migrateFundV2ToV1,
    // Going up these are guesses; going down they are the price of the
    // projection. Same list, two directions, both worth surfacing.
    derives: FUND_V2_GUESSED_FIELDS,
    lossy: FUND_V2_GUESSED_FIELDS,
  },
);

/**
 * Contribute this build's steps to the page-wide registry. This is the
 * federation dividend: the HOST is a v1-only build, but both bundles share
 * one `@braid/skew` instance, so once this (newer) bundle has loaded, the
 * host's own `read()` can migrate a v2 fund *down* through the step
 * registered here — its `ahead` dead end becomes an honest, lossy projection.
 */
registerSchema(FundSchemaV2);

/**
 * The list envelope the host actually holds — an array of `FundV1`. Derived
 * from the single-fund schema, so the two chains cannot drift apart.
 */
export const FundListSchemaV2 = versionedList(FundSchemaV2, 'portfolio-funds');

// --- orders --------------------------------------------------------------

/** v1, frozen as the remote received it. Never edited again. */
interface OrderV1 {
  fundId: string;
  action: 'raise-cash' | 'sell-holding' | 'defer-redemption';
  ticker?: string;
  amount: number;
  note?: string;
}

export interface OrderV2 {
  fundId: string;
  action: 'raise-cash' | 'sell-holding' | 'defer-redemption';
  ticker?: string;
  amount: { value: number; currency: string };
  note?: string;
  breachRef: string;
  idempotencyKey: string;
}

/**
 * v1 → v2. Used to migrate an order queued as v1 after the API's `/v2/orders`
 * refuses it with `version-skew` — see `order-outbox.ts`.
 *
 * `breachRef` cannot be recovered once the original breach context is gone;
 * rather than inventing a plausible-looking reference, this is left as
 * `'unknown'` and the UI says so.
 *
 * The idempotency key is derived from `ctx.seed` — the outbox passes the
 * queued entry's stable id — never from the clock. A clock-derived key mints
 * a *new* identity on every retry, which is the one property an idempotency
 * key must not have: a flaky network plus a retry loop would submit the same
 * order as many times as it took to "succeed".
 */
export const OrderSchemaV2 = versioned<OrderV1>(
  'portfolio-order',
).next<OrderV2>(
  'wrap amount in a currency, and add the fields v1 never required',
  (v1, ctx) => ({
    fundId: v1.fundId,
    action: v1.action,
    ticker: v1.ticker,
    amount: { value: v1.amount, currency: 'USD' },
    note: v1.note,
    breachRef: 'unknown',
    idempotencyKey: `migrated-${v1.fundId}-${ctx.seed ?? 'unseeded'}`,
  }),
);

// --- streams (unversioned payload shape, same as the host's) -------------

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

/** Key the host writes the selected fund's v1 record under before navigating. */
export const SELECTED_FUND_KEY = 'portfolio:selected-fund';

/**
 * Where the mock portfolio API is reachable, decided at runtime by which port
 * this code is currently executing under — the same static build serves both
 * modes, and the same code runs whether federated into the host or standalone.
 *
 * `location` always reflects wherever this code is actually running: the
 * host's origin when federated (same as the `federated` check in
 * `fund-detail.ts`), or the remote's own origin when standalone. Either way,
 * checking the port is enough to know whether a same-origin proxy is in front
 * of this page — see the matching comment in the host's `contracts.ts`.
 */
const DIRECT_PORTS = new Set(['4410', '4411']);

function isDirectMode(): boolean {
  return DIRECT_PORTS.has(globalThis.location?.port ?? '');
}

export const API_BASE = isDirectMode() ? 'http://localhost:3333/api' : '/api';
export const WS_TICKER_URL = isDirectMode()
  ? 'ws://localhost:3333/ws/ticker'
  : `ws://${globalThis.location?.host}/ws/ticker`;
