import { CompiledLens, compileLens } from '@skewkit/core';
import type { SkewContractDocument } from '@skewkit/contract';

/**
 * The portfolio-fund contract, as data — the single definition this server
 * publishes to clients AND consumes itself.
 *
 * Three parties used to hold three copies of this knowledge: `to-v2.ts` here,
 * and a hand-frozen `contracts.ts` in each Angular app. They could drift, and
 * nothing would say so. Now the server serves `/v1` by running this document's
 * *down* direction over canonical v2 data, publishes the document at
 * `/.well-known/skew/contracts/portfolio-fund`, and any client — including one
 * built before v2 existed — can fetch it and migrate in either direction.
 *
 * The asymmetry the demo teaches is preserved, sharpened even: the fields the
 * up direction fills (`hqlaPct`, `liquidityTier`, `classification`) are
 * *guesses*, flagged `derived` right here in the document. The server never
 * runs the up direction — it has the real values. A client migrating a v1
 * record it already holds has no choice. The fund-detail reconciliation view
 * is the difference between those two, made visible.
 */
export const FUND_CONTRACT: SkewContractDocument = {
  skewContract: '1',
  name: 'portfolio-fund',
  current: 2,
  steps: [
    {
      from: 1,
      to: 2,
      description:
        'promote scalars to structure; add liquidity and classification fields v1 never carried',
      ops: [
        { rename: { from: 'currency', to: 'baseCurrency' } },
        { wrap: { path: 'nav', key: 'amount', also: { asOf: { $now: true } } } },
        { move: { from: 'cashPct', to: 'liquidity.cashPct' } },
        { default: { path: 'liquidity.hqlaPct', value: 0 } },
        { default: { path: 'liquidity.redemptionCoverDays', value: 0 } },
        {
          default: {
            path: 'classification',
            value: { assetClass: 'unknown', strategy: 'unknown' },
          },
        },
        {
          map: {
            path: 'holdings',
            ops: [
              {
                wrap: {
                  path: 'marketValue',
                  key: 'amount',
                  also: { currency: { $from: '/baseCurrency' } },
                },
              },
              { default: { path: 'liquidityTier', value: 'T2' } },
            ],
          },
        },
      ],
    },
  ],
  schemas: {
    '1': {
      type: 'object',
      required: ['id', 'name', 'currency', 'nav', 'cashPct', 'holdings'],
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        currency: { type: 'string' },
        nav: { type: 'number' },
        cashPct: { type: 'number' },
        holdings: {
          type: 'array',
          items: {
            type: 'object',
            required: ['ticker', 'name', 'weightPct', 'marketValue'],
            properties: {
              ticker: { type: 'string' },
              name: { type: 'string' },
              weightPct: { type: 'number' },
              marketValue: { type: 'number' },
            },
          },
        },
      },
    },
    '2': {
      type: 'object',
      required: [
        'id',
        'name',
        'baseCurrency',
        'nav',
        'liquidity',
        'classification',
        'holdings',
      ],
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        baseCurrency: { type: 'string' },
        nav: {
          type: 'object',
          required: ['amount', 'asOf'],
          properties: { amount: { type: 'number' }, asOf: { type: 'string' } },
        },
        liquidity: {
          type: 'object',
          required: ['cashPct', 'hqlaPct', 'redemptionCoverDays'],
          properties: {
            cashPct: { type: 'number' },
            hqlaPct: { type: 'number' },
            redemptionCoverDays: { type: 'number' },
          },
        },
        classification: {
          type: 'object',
          required: ['assetClass', 'strategy'],
          properties: {
            assetClass: { type: 'string' },
            strategy: { type: 'string' },
          },
        },
        holdings: {
          type: 'array',
          items: {
            type: 'object',
            required: ['ticker', 'name', 'weightPct', 'marketValue', 'liquidityTier'],
            properties: {
              ticker: { type: 'string' },
              name: { type: 'string' },
              weightPct: { type: 'number' },
              marketValue: {
                type: 'object',
                required: ['amount', 'currency'],
                properties: {
                  amount: { type: 'number' },
                  currency: { type: 'string' },
                },
              },
              liquidityTier: { enum: ['T1', 'T2', 'T3'] },
            },
          },
        },
      },
    },
  },
};

/**
 * The compiled v1 ↔ v2 lens the server itself uses: `/v1/funds` is this
 * lens's down direction over canonical v2 data. One definition; the endpoint
 * and the published document cannot drift.
 */
export const fundLens: CompiledLens = compileLens(FUND_CONTRACT.steps[0]?.ops ?? []);

/** The version of the fund contract each endpoint family serves. */
export const FUND_CONTRACT_VERSIONS = { v1: 1, v2: 2 } as const;
