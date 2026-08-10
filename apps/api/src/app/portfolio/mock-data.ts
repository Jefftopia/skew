/**
 * Deterministic mock portfolio data — a fixed literal array, not generated at
 * boot. Random data at startup makes every reload a different demo and makes
 * bugs unreproducible; only the streams (Phases 3–4) are meant to move.
 *
 * Eight funds, tickers deliberately reused across funds so a single price
 * movement in the ticker feed (Phase 4) has more than one fund to drill into.
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

/**
 * Data v1 cannot express, held alongside it so the server's v2 upgrade
 * (`to-v2.ts`) reports *real* figures rather than the zeroed defaults a
 * client-side migration has to fall back to. That gap — real server data vs.
 * a client's best guess — is what the reconciliation UI in the remote's fund
 * detail view exists to surface.
 */
export interface FundV2Extras {
  hqlaPct: number;
  redemptionCoverDays: number;
  assetClass: string;
  strategy: string;
  /** Per-ticker liquidity tier, keyed by the holding's ticker. */
  liquidityTierByTicker: Record<string, 'T1' | 'T2' | 'T3'>;
}

export const funds: readonly FundV1[] = [
  {
    id: 'f-global-equity',
    name: 'Global Equity Growth Fund',
    currency: 'USD',
    nav: 128_450_000,
    cashPct: 4.2,
    holdings: [
      {
        ticker: 'AAPL',
        name: 'Apple Inc.',
        weightPct: 8.4,
        marketValue: 10_789_800,
      },
      {
        ticker: 'MSFT',
        name: 'Microsoft Corp.',
        weightPct: 7.9,
        marketValue: 10_147_550,
      },
      {
        ticker: 'NVDA',
        name: 'NVIDIA Corp.',
        weightPct: 6.1,
        marketValue: 7_835_450,
      },
      {
        ticker: 'AMZN',
        name: 'Amazon.com Inc.',
        weightPct: 5.3,
        marketValue: 6_807_850,
      },
      {
        ticker: 'GOOGL',
        name: 'Alphabet Inc. Class A',
        weightPct: 4.8,
        marketValue: 6_165_600,
      },
      {
        ticker: 'META',
        name: 'Meta Platforms Inc.',
        weightPct: 4.1,
        marketValue: 5_266_450,
      },
      {
        ticker: 'JPM',
        name: 'JPMorgan Chase & Co.',
        weightPct: 3.6,
        marketValue: 4_624_200,
      },
    ],
  },
  {
    id: 'f-em-debt',
    name: 'Emerging Markets Debt Fund',
    currency: 'USD',
    nav: 64_200_000,
    cashPct: 6.8,
    holdings: [
      {
        ticker: 'EMB-BRZ25',
        name: 'Brazil Sovereign 2025',
        weightPct: 9.2,
        marketValue: 5_906_400,
      },
      {
        ticker: 'EMB-MEX28',
        name: 'Mexico Sovereign 2028',
        weightPct: 8.5,
        marketValue: 5_457_000,
      },
      {
        ticker: 'EMB-IDN27',
        name: 'Indonesia Sovereign 2027',
        weightPct: 7.1,
        marketValue: 4_558_200,
      },
      {
        ticker: 'EMB-ZAF26',
        name: 'South Africa Sovereign 2026',
        weightPct: 6.4,
        marketValue: 4_108_800,
      },
      {
        ticker: 'AAPL',
        name: 'Apple Inc.',
        weightPct: 1.2,
        marketValue: 770_400,
      },
    ],
  },
  {
    id: 'f-ig-credit',
    name: 'Investment Grade Credit Fund',
    currency: 'USD',
    nav: 91_300_000,
    cashPct: 3.5,
    holdings: [
      {
        ticker: 'IG-JPM29',
        name: 'JPMorgan Chase 4.5% 2029',
        weightPct: 7.8,
        marketValue: 7_121_400,
      },
      {
        ticker: 'IG-MSFT30',
        name: 'Microsoft Corp 4.2% 2030',
        weightPct: 7.2,
        marketValue: 6_573_600,
      },
      {
        ticker: 'IG-VZ28',
        name: 'Verizon Communications 4.8% 2028',
        weightPct: 6.5,
        marketValue: 5_934_500,
      },
      {
        ticker: 'JPM',
        name: 'JPMorgan Chase & Co.',
        weightPct: 2.1,
        marketValue: 1_917_300,
      },
      {
        ticker: 'MSFT',
        name: 'Microsoft Corp.',
        weightPct: 1.8,
        marketValue: 1_643_400,
      },
    ],
  },
  {
    id: 'f-short-duration-liquidity',
    name: 'Short Duration Liquidity Fund',
    currency: 'USD',
    nav: 38_600_000,
    cashPct: 22.5,
    holdings: [
      {
        ticker: 'TBILL-3M',
        name: 'US Treasury Bill 3M',
        weightPct: 34.0,
        marketValue: 13_124_000,
      },
      {
        ticker: 'TBILL-6M',
        name: 'US Treasury Bill 6M',
        weightPct: 21.5,
        marketValue: 8_299_000,
      },
      {
        ticker: 'IG-VZ28',
        name: 'Verizon Communications 4.8% 2028',
        weightPct: 5.0,
        marketValue: 1_930_000,
      },
    ],
  },
  {
    id: 'f-multi-asset-balanced',
    name: 'Multi-Asset Balanced Fund',
    currency: 'USD',
    nav: 156_800_000,
    cashPct: 5.1,
    holdings: [
      {
        ticker: 'AAPL',
        name: 'Apple Inc.',
        weightPct: 4.6,
        marketValue: 7_212_800,
      },
      {
        ticker: 'MSFT',
        name: 'Microsoft Corp.',
        weightPct: 4.2,
        marketValue: 6_585_600,
      },
      {
        ticker: 'AMZN',
        name: 'Amazon.com Inc.',
        weightPct: 3.1,
        marketValue: 4_860_800,
      },
      {
        ticker: 'IG-JPM29',
        name: 'JPMorgan Chase 4.5% 2029',
        weightPct: 6.8,
        marketValue: 10_662_400,
      },
      {
        ticker: 'REIT-AVB',
        name: 'AvalonBay Communities',
        weightPct: 3.9,
        marketValue: 6_115_200,
      },
      {
        ticker: 'TBILL-3M',
        name: 'US Treasury Bill 3M',
        weightPct: 8.0,
        marketValue: 12_544_000,
      },
    ],
  },
  {
    id: 'f-reit-income',
    name: 'REIT Income Fund',
    currency: 'USD',
    nav: 47_900_000,
    cashPct: 3.9,
    holdings: [
      {
        ticker: 'REIT-AVB',
        name: 'AvalonBay Communities',
        weightPct: 11.4,
        marketValue: 5_460_600,
      },
      {
        ticker: 'REIT-PLD',
        name: 'Prologis Inc.',
        weightPct: 10.1,
        marketValue: 4_837_900,
      },
      {
        ticker: 'REIT-SPG',
        name: 'Simon Property Group',
        weightPct: 8.7,
        marketValue: 4_167_300,
      },
      {
        ticker: 'REIT-O',
        name: 'Realty Income Corp.',
        weightPct: 7.2,
        marketValue: 3_448_800,
      },
    ],
  },
  {
    id: 'f-high-yield',
    name: 'High Yield Bond Fund',
    currency: 'USD',
    nav: 73_500_000,
    cashPct: 4.6,
    holdings: [
      {
        ticker: 'HY-CCL27',
        name: 'Carnival Corp 7.6% 2027',
        weightPct: 6.9,
        marketValue: 5_071_500,
      },
      {
        ticker: 'HY-AAL28',
        name: 'American Airlines 8.1% 2028',
        weightPct: 6.2,
        marketValue: 4_557_000,
      },
      {
        ticker: 'HY-OXY26',
        name: 'Occidental Petroleum 6.6% 2026',
        weightPct: 5.8,
        marketValue: 4_263_000,
      },
      {
        ticker: 'META',
        name: 'Meta Platforms Inc.',
        weightPct: 1.4,
        marketValue: 1_029_000,
      },
    ],
  },
  {
    id: 'f-gilt',
    name: 'UK Gilt Fund',
    currency: 'GBP',
    nav: 55_200_000,
    cashPct: 7.3,
    holdings: [
      {
        ticker: 'GILT-2031',
        name: 'UK Treasury Gilt 2031',
        weightPct: 28.4,
        marketValue: 15_676_800,
      },
      {
        ticker: 'GILT-2035',
        name: 'UK Treasury Gilt 2035',
        weightPct: 19.6,
        marketValue: 10_819_200,
      },
      {
        ticker: 'GILT-2040',
        name: 'UK Treasury Gilt 2040',
        weightPct: 12.1,
        marketValue: 6_679_200,
      },
    ],
  },
];

export const v2ExtrasByFundId: Readonly<Record<string, FundV2Extras>> = {
  'f-global-equity': {
    hqlaPct: 62.5,
    redemptionCoverDays: 4,
    assetClass: 'Equity',
    strategy: 'Global Large-Cap Growth',
    liquidityTierByTicker: {
      AAPL: 'T1',
      MSFT: 'T1',
      NVDA: 'T1',
      AMZN: 'T1',
      GOOGL: 'T1',
      META: 'T1',
      JPM: 'T1',
    },
  },
  'f-em-debt': {
    hqlaPct: 28.0,
    redemptionCoverDays: 12,
    assetClass: 'Fixed Income',
    strategy: 'Emerging Markets Sovereign',
    liquidityTierByTicker: {
      'EMB-BRZ25': 'T2',
      'EMB-MEX28': 'T2',
      'EMB-IDN27': 'T3',
      'EMB-ZAF26': 'T3',
      AAPL: 'T1',
    },
  },
  'f-ig-credit': {
    hqlaPct: 41.0,
    redemptionCoverDays: 6,
    assetClass: 'Fixed Income',
    strategy: 'Investment Grade Corporate',
    liquidityTierByTicker: {
      'IG-JPM29': 'T2',
      'IG-MSFT30': 'T2',
      'IG-VZ28': 'T2',
      JPM: 'T1',
      MSFT: 'T1',
    },
  },
  'f-short-duration-liquidity': {
    hqlaPct: 91.0,
    redemptionCoverDays: 1,
    assetClass: 'Cash & Equivalents',
    strategy: 'Short Duration Liquidity',
    liquidityTierByTicker: {
      'TBILL-3M': 'T1',
      'TBILL-6M': 'T1',
      'IG-VZ28': 'T2',
    },
  },
  'f-multi-asset-balanced': {
    hqlaPct: 55.0,
    redemptionCoverDays: 5,
    assetClass: 'Multi-Asset',
    strategy: 'Balanced Growth & Income',
    liquidityTierByTicker: {
      AAPL: 'T1',
      MSFT: 'T1',
      AMZN: 'T1',
      'IG-JPM29': 'T2',
      'REIT-AVB': 'T2',
      'TBILL-3M': 'T1',
    },
  },
  'f-reit-income': {
    hqlaPct: 18.0,
    redemptionCoverDays: 18,
    assetClass: 'Real Estate',
    strategy: 'Income-Focused REIT',
    liquidityTierByTicker: {
      'REIT-AVB': 'T3',
      'REIT-PLD': 'T3',
      'REIT-SPG': 'T3',
      'REIT-O': 'T3',
    },
  },
  'f-high-yield': {
    hqlaPct: 24.0,
    redemptionCoverDays: 15,
    assetClass: 'Fixed Income',
    strategy: 'High Yield Corporate',
    liquidityTierByTicker: {
      'HY-CCL27': 'T3',
      'HY-AAL28': 'T3',
      'HY-OXY26': 'T3',
      META: 'T1',
    },
  },
  'f-gilt': {
    hqlaPct: 88.0,
    redemptionCoverDays: 2,
    assetClass: 'Fixed Income',
    strategy: 'UK Government Bonds',
    liquidityTierByTicker: {
      'GILT-2031': 'T1',
      'GILT-2035': 'T1',
      'GILT-2040': 'T2',
    },
  },
};

export function findFund(id: string): FundV1 | undefined {
  return funds.find((f) => f.id === id);
}
