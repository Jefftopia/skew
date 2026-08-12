import { afterEach, describe, expect, it } from 'vitest';
import { MigrationContext, resetSchemaRegistry, versioned } from '@skewkit/core';
import { SkewContractDocument } from './document.js';
import { versionedFromContract } from './schema-from-contract.js';
import { FUND_CONTRACT } from './document.spec.js';

const pinnedClock: MigrationContext = { now: () => new Date('2026-08-10T12:00:00.000Z') };

interface FundV1 {
  id: string;
  name: string;
  currency: string;
  nav: number;
  cashPct: number;
  holdings: { ticker: string; marketValue: number }[];
}

const fundV1: FundV1 = {
  id: 'f1',
  name: 'Short Duration Income',
  currency: 'USD',
  nav: 100,
  cashPct: 4,
  holdings: [{ ticker: 'TBILL-3M', marketValue: 40 }],
};

afterEach(() => resetSchemaRegistry());

describe('versionedFromContract', () => {
  it('builds a working schema at the document current version', () => {
    const schema = versionedFromContract(FUND_CONTRACT);
    expect(schema.name).toBe('portfolio-fund');
    expect(schema.version).toBe(2);

    const result = schema.read({ v: 1, payload: fundV1 }, { context: pinnedClock });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const v2 = result.value as Record<string, any>;
      expect(v2['baseCurrency']).toBe('USD');
      expect(v2['nav']).toEqual({ amount: 100, asOf: '2026-08-10T12:00:00.000Z' });
      expect(v2['liquidity']).toEqual({ cashPct: 4, hqlaPct: 0, redemptionCoverDays: 0 });
      expect(v2['holdings']).toEqual([
        { ticker: 'TBILL-3M', marketValue: { amount: 40, currency: 'USD' }, liquidityTier: 'T2' },
      ]);
      expect(result.derivedPaths).toContain('liquidity.hqlaPct');
      expect(result.derivedPaths).toContain('holdings[].liquidityTier');
    }
  });

  it('the ops-derived down direction writes for older readers', () => {
    const schema = versionedFromContract(FUND_CONTRACT);
    const up = schema.read({ v: 1, payload: fundV1 }, { context: pinnedClock });
    if (!up.ok) throw new Error('setup failed');

    const envelope = schema.write(up.value, { as: 1 });
    expect(envelope.v).toBe(1);
    expect(envelope.payload).toMatchObject({ currency: 'USD', nav: 100, cashPct: 4 });
  });

  it('a build pinned at v1 can read v2 data — the cure for ahead', () => {
    // The pinned build only *runs* v1, but adopting the document taught the
    // registry the v1 → v2 step, including its down direction.
    const schema = versionedFromContract<FundV1>(FUND_CONTRACT, { at: 1 });
    expect(schema.version).toBe(1);

    const v2Record = {
      v: 2,
      payload: {
        id: 'f1',
        name: 'Short Duration Income',
        baseCurrency: 'EUR',
        nav: { amount: 250, asOf: '2026-08-01T00:00:00.000Z' },
        liquidity: { cashPct: 3, hqlaPct: 61, redemptionCoverDays: 12 },
        classification: { assetClass: 'fixed-income', strategy: 'short-duration' },
        holdings: [
          { ticker: 'TBILL-3M', marketValue: { amount: 40, currency: 'EUR' }, liquidityTier: 'T1' },
        ],
      },
    };

    const result = schema.read(v2Record);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.downgradedFrom).toBe(2);
      expect(result.value).toMatchObject({ currency: 'EUR', nav: 250, cashPct: 3 });
      expect(result.value.holdings).toEqual([{ ticker: 'TBILL-3M', marketValue: 40 }]);
      expect(result.lossyPaths).toContain('nav.asOf');
      expect(result.lossyPaths).toContain('liquidity.hqlaPct');
    }
  });

  it('without registration the pinned build refuses ahead, as a plain v1 schema would', () => {
    versionedFromContract<FundV1>(FUND_CONTRACT, { at: 1, register: false });
    const plain = versioned<FundV1>('portfolio-fund');
    const result = plain.read({ v: 2, payload: {} });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('ahead');
  });

  it('rejects pinning outside the documented range', () => {
    expect(() => versionedFromContract(FUND_CONTRACT, { at: 3 })).toThrow(/v1 through v2/);
  });
});

describe('named code steps — the escape hatch', () => {
  const semanticContract: SkewContractDocument = {
    skewContract: '1',
    name: 'draft',
    current: 3,
    steps: [
      { from: 1, to: 2, description: 'derive summary from body', code: 'derive-summary' },
      { from: 2, to: 3, description: 'rename title to headline', ops: [{ rename: { from: 'title', to: 'headline' } }] },
    ],
  };

  it('runs a code step when the bundle ships the implementation', () => {
    const schema = versionedFromContract(semanticContract, {
      codeSteps: {
        'derive-summary': {
          up: (v1: { body: string }) => ({ ...v1, summary: v1.body.split('\n')[0] ?? '' }),
          derives: ['summary'],
        },
      },
    });

    const result = schema.read({ v: 1, payload: { title: 'T', body: 'first line\nrest' } });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.value as Record<string, unknown>)['summary']).toBe('first line');
      expect((result.value as Record<string, unknown>)['headline']).toBe('T');
      expect(result.derivedPaths).toEqual(['summary']);
    }
  });

  it('degrades to gap — loudly, not with a guess — when the implementation is missing', () => {
    const schema = versionedFromContract(semanticContract, { register: false });

    // v2 data only needs the ops step — it still works.
    const fromV2 = schema.read({ v: 2, payload: { title: 'T', body: 'b', summary: 's' } });
    expect(fromV2.ok).toBe(true);

    // v1 data needs the code step this bundle does not carry.
    const fromV1 = schema.read({ v: 1, payload: { title: 'T', body: 'b' } });
    expect(fromV1.ok).toBe(false);
    if (!fromV1.ok) expect(fromV1.reason).toBe('gap');
  });
});
