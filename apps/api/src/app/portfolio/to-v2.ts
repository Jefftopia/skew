import { FundV1, HoldingV1, v2ExtrasByFundId } from './mock-data';

/**
 * The server's own v1 → v2 upgrade — independent of, and not shared with, the
 * client-side migration the Angular remote declares for the same shape.
 *
 * They agree on the fields v1 can supply (renamed, promoted) and *disagree* on
 * the fields v1 cannot (`hqlaPct`, `liquidityTier`, `classification`): this
 * function reports real per-fund data from `v2ExtrasByFundId`, while a client
 * migrating a v1 record it already holds has no such source and must default
 * them. That gap is deliberate — it is what the remote's reconciliation view
 * exists to surface.
 */

export interface HoldingV2 {
  ticker: string;
  name: string;
  weightPct: number;
  marketValue: { amount: number; currency: string };
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

function toHoldingV2(
  h: HoldingV1,
  currency: string,
  tierByTicker: Record<string, 'T1' | 'T2' | 'T3'>,
): HoldingV2 {
  return {
    ticker: h.ticker,
    name: h.name,
    weightPct: h.weightPct,
    marketValue: { amount: h.marketValue, currency },
    liquidityTier: tierByTicker[h.ticker] ?? 'T2',
  };
}

export function toFundV2(fund: FundV1, asOf: string): FundV2 {
  const extras = v2ExtrasByFundId[fund.id];
  if (!extras) {
    throw new Error(`[api] no v2 extras registered for fund "${fund.id}"`);
  }

  return {
    id: fund.id,
    name: fund.name,
    baseCurrency: fund.currency,
    nav: { amount: fund.nav, asOf },
    liquidity: {
      cashPct: fund.cashPct,
      hqlaPct: extras.hqlaPct,
      redemptionCoverDays: extras.redemptionCoverDays,
    },
    classification: {
      assetClass: extras.assetClass,
      strategy: extras.strategy,
    },
    holdings: fund.holdings.map((h) =>
      toHoldingV2(h, fund.currency, extras.liquidityTierByTicker),
    ),
  };
}
