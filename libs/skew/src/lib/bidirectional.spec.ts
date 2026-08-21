import { describe, expect, it } from 'vitest';
import { MigrationContext } from './context.js';
import { versioned } from './versioned.js';

/**
 * The scenario these tests guard: a host built against v1 and a remote built
 * against v2 sharing one page. Data flows both ways, so migration must too.
 */

interface FundV1 {
  id: string;
  currency: string;
  nav: number;
}
interface FundV2 {
  id: string;
  baseCurrency: string;
  nav: { amount: number; asOf: string };
  hqlaPct: number;
}

const pinned: MigrationContext = { now: () => new Date('2026-08-10T12:00:00.000Z') };

/** The newer party's chain: up and down both declared. */
const FundV2Schema = versioned<FundV1>('fund').next<FundV2>('promote nav; add hqlaPct', {
  up: (v1, ctx) => ({
    id: v1.id,
    baseCurrency: v1.currency,
    nav: { amount: v1.nav, asOf: ctx.now().toISOString() },
    hqlaPct: 0,
  }),
  down: (v2) => ({ id: v2.id, currency: v2.baseCurrency, nav: v2.nav.amount }),
  derives: ['nav.asOf', 'hqlaPct'],
  lossy: ['nav.asOf', 'hqlaPct'],
});

describe('bidirectional steps', () => {
  it('still migrates up, reporting which fields are guesses', () => {
    const result = FundV2Schema.read({ v: 1, payload: { id: 'f1', currency: 'USD', nav: 100 } }, { context: pinned });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.migratedFrom).toBe(1);
      expect(result.downgradedFrom).toBeNull();
      expect(result.value.nav).toEqual({ amount: 100, asOf: '2026-08-10T12:00:00.000Z' });
      expect(result.derivedPaths).toEqual(['nav.asOf', 'hqlaPct']);
      expect(result.lossyPaths).toEqual([]);
    }
  });

  it('writes at an older version on request — writer-makes-right', () => {
    const v2: FundV2 = {
      id: 'f1',
      baseCurrency: 'EUR',
      nav: { amount: 250, asOf: '2026-08-01T00:00:00.000Z' },
      hqlaPct: 12,
    };

    const envelope = FundV2Schema.write(v2, { as: 1 });

    expect(envelope.v).toBe(1);
    expect(envelope.n).toBe('fund');
    expect(envelope.payload).toEqual({ id: 'f1', currency: 'EUR', nav: 250 });
  });

  it('refuses to write at a version the chain cannot reach downward', () => {
    const oneWay = versioned<FundV1>('one-way').next<FundV2>('promote nav', (v1, ctx) => ({
      id: v1.id,
      baseCurrency: v1.currency,
      nav: { amount: v1.nav, asOf: ctx.now().toISOString() },
      hqlaPct: 0,
    }));

    expect(() =>
      oneWay.write({ id: 'x', baseCurrency: 'USD', nav: { amount: 1, asOf: '' }, hqlaPct: 0 }, { as: 1 }),
    ).toThrow(/no down-migration/);
  });

  it('refuses to write at a version newer than the build knows', () => {
    expect(() =>
      FundV2Schema.write({ id: 'x', baseCurrency: 'USD', nav: { amount: 1, asOf: '' }, hqlaPct: 0 }, { as: 3 }),
    ).toThrow(/knows v1 through v2/);
  });

  it('keeps the legacy write(value, buildId) form working', () => {
    const envelope = FundV2Schema.write(
      { id: 'x', baseCurrency: 'USD', nav: { amount: 1, asOf: '' }, hqlaPct: 0 },
      'build-42',
    );
    expect(envelope.v).toBe(2);
    expect(envelope.b).toBe('build-42');
  });
});

describe('reading newer data (the ahead case)', () => {
  // The OLDER party: v1 only, knows nothing of v2. This is the host.
  const FundV1Schema = versioned<FundV1>('fund-v1-only');

  it('still refuses when no down path exists anywhere', () => {
    const result = FundV1Schema.read({ v: 2, payload: { id: 'f1' } });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('ahead');
      expect(result.message).toContain('newer build');
    }
  });

  it('downgrades through its own chain when the reader is a newer build pinned lower — via write({as}) round trip', () => {
    // The newer build writes down for the older reader...
    const written = FundV2Schema.write(
      { id: 'f9', baseCurrency: 'GBP', nav: { amount: 7, asOf: '2026-01-01T00:00:00.000Z' }, hqlaPct: 3 },
      { as: 1 },
    );
    // ...and a v1-only reader of the same contract name reads it natively.
    const v1Reader = versioned<FundV1>('fund');
    const result = v1Reader.read(written);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ id: 'f9', currency: 'GBP', nav: 7 });
  });
});

describe('envelope contract identity', () => {
  it('refuses an envelope naming a different contract instead of misreading it', () => {
    const Draft = versioned<{ id: string }>('draft');
    const written = versioned<{ id: string }>('order').write({ id: 'o1' });

    const result = Draft.read(written);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('invalid');
      expect(result.message).toContain('"order"');
      expect(result.message).toContain('"draft"');
    }
  });

  it('accepts hand-written envelopes without a name — the wire format is the contract', () => {
    const Draft = versioned<{ id: string }>('draft');
    expect(Draft.read({ v: 1, payload: { id: 'd1' } }).ok).toBe(true);
  });
});

describe('read options', () => {
  it('assumeVersion lets the caller carry the version out of band, URL-style', () => {
    const schema = versioned<FundV1>('bare').next<FundV2>('promote', {
      up: (v1, ctx) => ({
        id: v1.id,
        baseCurrency: v1.currency,
        nav: { amount: v1.nav, asOf: ctx.now().toISOString() },
        hqlaPct: 0,
      }),
      down: (v2) => ({ id: v2.id, currency: v2.baseCurrency, nav: v2.nav.amount }),
    });

    // A bare v2 body from `/v2/funds` — without assumeVersion this would be
    // catastrophically misread as legacy v1 and "migrated".
    const bareV2 = { id: 'f1', baseCurrency: 'USD', nav: { amount: 5, asOf: 'x' }, hqlaPct: 1 };
    const result = schema.read(bareV2, { assumeVersion: 2 });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.migratedFrom).toBeNull();
      expect(result.value).toEqual(bareV2);
    }
  });

  it('the envelope wins over assumeVersion — the writer knows best', () => {
    const schema = versioned<{ a: number }>('env-wins');
    const result = schema.read({ v: 1, payload: { a: 1 } }, { assumeVersion: 99 });
    expect(result.ok).toBe(true);
  });
});

describe('required descriptions', () => {
  it('rejects a step declared without one', () => {
    expect(() =>
      versioned<{ a: 1 }>('anon').next<{ b: 1 }>('', () => ({ b: 1 })),
    ).toThrow(/description/);
  });
});

describe('determinism', () => {
  it('two reads with the same pinned context agree exactly', () => {
    const stored = { v: 1, payload: { id: 'f1', currency: 'USD', nav: 100 } };
    const first = FundV2Schema.read(stored, { context: pinned });
    const second = FundV2Schema.read(stored, { context: pinned });
    expect(first).toEqual(second);
  });
});
