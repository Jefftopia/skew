/**
 * Deterministic mock portfolio data — a fixed literal, not generated at boot.
 * Random data at startup makes every reload a different demo and makes bugs
 * unreproducible; only the ticker feed is meant to move.
 *
 * Kept deliberately small — five funds, twenty tickers. An earlier version had
 * eight funds and enough holdings to fill a screen, which made the *data* the
 * thing you had to study before you could look at the thing being
 * demonstrated. A demo that needs a legend is too big.
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
 * Held by every single fund, on purpose.
 *
 * A liquidity breach on this ticker touches the whole book, so one button
 * press produces an event whose blast radius is visible everywhere at once —
 * every fund flagged, every drill-down populated. Picking a ticker held by two
 * of eight funds made the feature look broken when the two you were looking at
 * were not among them.
 */
export const UNIVERSAL_TICKER = 'TBILL-3M';

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
        ticker: 'JPM',
        name: 'JPMorgan Chase & Co.',
        weightPct: 3.6,
        marketValue: 4_624_200,
      },
      {
        ticker: UNIVERSAL_TICKER,
        name: 'US Treasury Bill 3M',
        weightPct: 3.1,
        marketValue: 3_981_950,
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
        ticker: UNIVERSAL_TICKER,
        name: 'US Treasury Bill 3M',
        weightPct: 5.4,
        marketValue: 3_466_800,
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
        ticker: UNIVERSAL_TICKER,
        name: 'US Treasury Bill 3M',
        weightPct: 4.0,
        marketValue: 3_652_000,
      },
    ],
  },
  {
    id: 'f-multi-asset',
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
        ticker: UNIVERSAL_TICKER,
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
        ticker: UNIVERSAL_TICKER,
        name: 'US Treasury Bill 3M',
        weightPct: 2.6,
        marketValue: 1_245_400,
      },
    ],
  },
];

/**
 * Data v1 cannot express, held alongside it so the server's v2 upgrade
 * (`to-v2.ts`) reports *real* figures rather than the zeroed defaults a
 * client-side migration has to fall back to. That gap — real server data vs. a
 * client's best guess — is what the reconciliation UI exists to surface.
 */
export interface FundV2Extras {
  hqlaPct: number;
  redemptionCoverDays: number;
  assetClass: string;
  strategy: string;
  liquidityTierByTicker: Record<string, 'T1' | 'T2' | 'T3'>;
}

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
      JPM: 'T1',
      [UNIVERSAL_TICKER]: 'T1',
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
      [UNIVERSAL_TICKER]: 'T1',
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
      [UNIVERSAL_TICKER]: 'T1',
    },
  },
  'f-multi-asset': {
    hqlaPct: 55.0,
    redemptionCoverDays: 5,
    assetClass: 'Multi-Asset',
    strategy: 'Balanced Growth & Income',
    liquidityTierByTicker: {
      AAPL: 'T1',
      MSFT: 'T1',
      'IG-JPM29': 'T2',
      'REIT-AVB': 'T2',
      [UNIVERSAL_TICKER]: 'T1',
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
      [UNIVERSAL_TICKER]: 'T1',
    },
  },
};

export function findFund(id: string): FundV1 | undefined {
  return funds.find((f) => f.id === id);
}
