/**
 * GENERATED FILE — do not edit by hand.
 *
 * In a real repo this file is emitted by:
 *
 *   skew-contract gen --in contracts/portfolio-fund.contract.json \
 *                     --out src/generated/portfolio-fund.contract.ts \
 *                     --type-prefix Fund --const-name PORTFOLIO_FUND_CONTRACT
 *
 * and regenerated + committed together with every contract change. Both the
 * NestJS API (owner of the contract) and every client run `gen` against the
 * same JSON document — the document is the single source of truth, and
 * generation is what enforces "never edit a past version's interface."
 *
 * These are FROZEN SNAPSHOT types: copies fixed at each documented version,
 * never imports of live application interfaces. Migration steps and
 * `versionedFromContract<T>()` close over them, so editing a live app model
 * can never silently change what an old migration produces.
 */

/** Shape of portfolio-fund at contract version 1 (frozen). */
export interface FundV1 {
  id: string;
  name: string;
  currency: string;
  cashPct: number;
}

/** Shape of portfolio-fund at contract version 2 (frozen, current). */
export interface FundV2 {
  id: string;
  name: string;
  baseCurrency: string;
  liquidity: {
    cashPct: number;
    hqlaPct: number;
  };
}

/**
 * The contract document as a typed const — identical to
 * contracts/portfolio-fund.contract.json. Nothing in it is executable: every
 * op comes from the closed whitelist (rename / move / wrap / hoist / map /
 * default / drop / convert / const), and each op knows its inverse, so
 * declaring the v1→v2 up-migration also buys clients the v2→v1 downgrade.
 */
export const PORTFOLIO_FUND_CONTRACT = {
  skewContract: '1',
  name: 'portfolio-fund',
  current: 2,
  steps: [
    {
      from: 1,
      to: 2,
      description:
        'rename currency to baseCurrency; move flat cashPct into liquidity; add liquidity.hqlaPct defaulting to 0',
      ops: [
        { rename: { from: 'currency', to: 'baseCurrency' } },
        { move: { from: 'cashPct', to: 'liquidity.cashPct' } },
        { default: { path: 'liquidity.hqlaPct', value: 0 } },
      ],
    },
  ],
  schemas: {
    '1': {
      $schema: 'http://json-schema.org/draft-07/schema#',
      title: 'PortfolioFund v1',
      type: 'object',
      required: ['id', 'name', 'currency', 'cashPct'],
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        currency: { type: 'string', pattern: '^[A-Z]{3}$' },
        cashPct: { type: 'number', minimum: 0, maximum: 100 },
      },
    },
    '2': {
      $schema: 'http://json-schema.org/draft-07/schema#',
      title: 'PortfolioFund v2',
      type: 'object',
      required: ['id', 'name', 'baseCurrency', 'liquidity'],
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        baseCurrency: { type: 'string', pattern: '^[A-Z]{3}$' },
        liquidity: {
          type: 'object',
          required: ['cashPct', 'hqlaPct'],
          properties: {
            cashPct: { type: 'number', minimum: 0, maximum: 100 },
            hqlaPct: { type: 'number', minimum: 0, maximum: 100 },
          },
        },
      },
    },
  },
} as const;
