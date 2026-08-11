import { describe, expect, it } from 'vitest';
import {
  SkewContractDocument,
  contractFingerprint,
  parseContractDocument,
  wellKnownContractPath,
  wellKnownContractUrl,
} from './document.js';

export const FUND_CONTRACT: SkewContractDocument = {
  skewContract: '1',
  name: 'portfolio-fund',
  current: 2,
  steps: [
    {
      from: 1,
      to: 2,
      description: 'promote scalars to structure; add liquidity fields v1 never carried',
      ops: [
        { rename: { from: 'currency', to: 'baseCurrency' } },
        { wrap: { path: 'nav', key: 'amount', also: { asOf: { $now: true } } } },
        { move: { from: 'cashPct', to: 'liquidity.cashPct' } },
        { default: { path: 'liquidity.hqlaPct', value: 0 } },
        { default: { path: 'liquidity.redemptionCoverDays', value: 0 } },
        { default: { path: 'classification', value: { assetClass: 'unknown', strategy: 'unknown' } } },
        {
          map: {
            path: 'holdings',
            ops: [
              { wrap: { path: 'marketValue', key: 'amount', also: { currency: { $from: '/baseCurrency' } } } },
              { default: { path: 'liquidityTier', value: 'T2' } },
            ],
          },
        },
      ],
    },
  ],
};

describe('parseContractDocument', () => {
  it('accepts a well-formed document', () => {
    expect(parseContractDocument(JSON.parse(JSON.stringify(FUND_CONTRACT)))).toEqual(FUND_CONTRACT);
  });

  it.each([
    [null, /must be an object/],
    [{ ...FUND_CONTRACT, skewContract: '2' }, /unsupported document format/],
    [{ ...FUND_CONTRACT, name: '' }, /name/],
    [{ ...FUND_CONTRACT, current: 0 }, /current/],
    [{ ...FUND_CONTRACT, steps: [] }, /contiguously/],
    [
      { ...FUND_CONTRACT, steps: [{ from: 1, to: 3, description: 'skips', ops: [] }] },
      /must target v2/,
    ],
    [
      { ...FUND_CONTRACT, steps: [{ from: 1, to: 2, description: '', ops: [] }] },
      /description/,
    ],
    [
      { ...FUND_CONTRACT, steps: [{ from: 1, to: 2, description: 'both', ops: [], code: 'x' }] },
      /exactly one/,
    ],
    [
      { ...FUND_CONTRACT, steps: [{ from: 1, to: 2, description: 'neither' }] },
      /exactly one/,
    ],
  ])('rejects a malformed document (%#)', (doc, message) => {
    expect(() => parseContractDocument(doc)).toThrow(message);
  });
});

describe('contractFingerprint', () => {
  it('is stable under key reordering', () => {
    const reordered = JSON.parse(
      JSON.stringify({ current: 2, steps: FUND_CONTRACT.steps, name: 'portfolio-fund', skewContract: '1' }),
    );
    expect(contractFingerprint(reordered)).toBe(contractFingerprint(FUND_CONTRACT));
  });

  it('moves when content moves', () => {
    const edited = { ...FUND_CONTRACT, current: 2, name: 'portfolio-fund-edited' };
    expect(contractFingerprint(edited)).not.toBe(contractFingerprint(FUND_CONTRACT));
  });
});

describe('well-known locations', () => {
  it('builds the path and the URL', () => {
    expect(wellKnownContractPath('portfolio-fund')).toBe('/.well-known/skew/contracts/portfolio-fund');
    expect(wellKnownContractUrl('http://localhost:3333', 'portfolio-fund')).toBe(
      'http://localhost:3333/.well-known/skew/contracts/portfolio-fund',
    );
    expect(wellKnownContractUrl('http://localhost:3333/', 'portfolio-fund')).toBe(
      'http://localhost:3333/.well-known/skew/contracts/portfolio-fund',
    );
  });
});
