import { describe, expect, it } from 'vitest';
import { isEnvelope, peekVersion, versioned } from './versioned.js';

// Snapshot shapes. Note these are *frozen copies* of past versions, never the
// live application types — that is the rule the migration chain depends on.
interface V1 {
  id: string;
  themeQuote?: { text: string };
}
interface V2 {
  id: string;
  scriptureOfWeek?: { text: string };
}
interface V3 {
  id: string;
  scriptureOfWeek?: { text: string };
  orderOfWorship: { setting: string; hymns: string[] };
}

const Schema = versioned<V1>('weekly-content')
  .next<V2>('rename themeQuote to scriptureOfWeek', (p) => ({
    id: p.id,
    scriptureOfWeek: p.themeQuote,
  }))
  .next<V3>('introduce orderOfWorship', (p) => ({
    ...p,
    orderOfWorship: { setting: '', hymns: [] },
  }));

describe('versioned()', () => {
  it('reports the version as one plus the number of steps', () => {
    expect(versioned<V1>('x').version).toBe(1);
    expect(Schema.version).toBe(3);
    expect(Schema.steps.map((s) => s.to)).toEqual([2, 3]);
  });

  it('round-trips a current-version value without migrating', () => {
    const value: V3 = { id: 'a', orderOfWorship: { setting: 'St. Ann', hymns: ['357'] } };
    const envelope = Schema.write(value);

    expect(envelope.v).toBe(3);
    const result = Schema.read(envelope);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual(value);
      expect(result.migratedFrom).toBeNull();
    }
  });

  it('migrates forward across the whole chain', () => {
    const stored = { v: 1, payload: { id: 'a', themeQuote: { text: 'Prepare the way' } } };

    const result = Schema.read(stored);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.migratedFrom).toBe(1);
      expect(result.value.scriptureOfWeek).toEqual({ text: 'Prepare the way' });
      expect(result.value.orderOfWorship).toEqual({ setting: '', hymns: [] });
      // the renamed field is gone
      expect((result.value as unknown as V1).themeQuote).toBeUndefined();
    }
  });

  it('migrates from an intermediate version', () => {
    const stored = { v: 2, payload: { id: 'b', scriptureOfWeek: { text: 'Rejoice' } } };

    const result = Schema.read(stored);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.migratedFrom).toBe(2);
      expect(result.value.orderOfWorship).toEqual({ setting: '', hymns: [] });
    }
  });

  describe('legacy adoption', () => {
    it('treats un-enveloped data as v1 so existing rows need no backfill', () => {
      const legacy = { id: 'c', themeQuote: { text: 'Comfort my people' } };

      const result = Schema.read(legacy);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.migratedFrom).toBe(1);
        expect(result.value.scriptureOfWeek).toEqual({ text: 'Comfort my people' });
      }
    });

    it('honours assumeLegacyVersion for mid-stream adoption', () => {
      const midStream = versioned<V1>('x', { assumeLegacyVersion: 2 })
        .next<V2>('rename', (p) => p as unknown as V2)
        .next<V3>('add orderOfWorship', (p) => ({ ...p, orderOfWorship: { setting: '', hymns: [] } }));

      // Bare data is now assumed to already be v2, so only the last step runs.
      const result = midStream.read({ id: 'd', scriptureOfWeek: { text: 'x' } });

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.migratedFrom).toBe(2);
    });
  });

  describe('failure modes', () => {
    it('refuses to migrate data from a newer build rather than silently dropping fields', () => {
      const fromFuture = { v: 9, payload: { id: 'e', somethingNew: true } };

      const result = Schema.read(fromFuture);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('ahead');
        expect(result.found).toBe(9);
        expect(result.expected).toBe(3);
        expect(result.message).toContain('newer build');
      }
    });

    it('reports a gap rather than skipping a missing step', () => {
      // A schema that jumped to v3 without declaring v2 cannot be built via the
      // fluent API, so simulate a corrupted step list.
      const broken = versioned<V1>('broken').next<V2>('rename', (p) => p as unknown as V2);
      (broken.steps as unknown as unknown[]).length = 0; // drop the declared step

      const result = broken.read({ v: 1, payload: { id: 'f' } });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('gap');
    });

    it('captures a throwing migration instead of propagating', () => {
      const explosive = versioned<V1>('explosive').next<V2>('boom', () => {
        throw new Error('bad data');
      });

      const result = explosive.read({ v: 1, payload: { id: 'g' } });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('threw');
        expect(result.message).toContain('boom');
        expect((result.cause as Error).message).toBe('bad data');
      }
    });

    it('rejects null and undefined', () => {
      expect(Schema.read(null).ok).toBe(false);
      expect(Schema.read(undefined).ok).toBe(false);
    });

    it('rejects a non-integer version', () => {
      const result = Schema.read({ v: 1.5, payload: {} });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('invalid');
    });
  });

  describe('validation', () => {
    const Validated = versioned<V1>('validated', {
      validate: (v): v is V1 => typeof (v as V1)?.id === 'string',
    });

    it('passes a well-formed value', () => {
      expect(Validated.read({ v: 1, payload: { id: 'ok' } }).ok).toBe(true);
    });

    it('fails a malformed value after migration', () => {
      const result = Validated.read({ v: 1, payload: { id: 42 } });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('invalid');
    });
  });

  it('records build identity on write when supplied', () => {
    const envelope = Schema.write(
      { id: 'h', orderOfWorship: { setting: '', hymns: [] } },
      'build-abc',
    );
    expect(envelope.b).toBe('build-abc');
  });

  it('does not mutate the source schema when extended', () => {
    const base = versioned<V1>('immutability');
    const extended = base.next<V2>('rename', (p) => p as unknown as V2);

    expect(base.version).toBe(1);
    expect(extended.version).toBe(2);
    expect(base.steps).toHaveLength(0);
  });
});

describe('envelope helpers', () => {
  it('detects envelopes', () => {
    expect(isEnvelope({ v: 1, payload: {} })).toBe(true);
    expect(isEnvelope({ id: 'bare' })).toBe(false);
    expect(isEnvelope(null)).toBe(false);
    expect(isEnvelope({ v: 'one', payload: {} })).toBe(false);
  });

  it('peeks the version without migrating', () => {
    expect(peekVersion({ v: 4, payload: {} })).toBe(4);
    expect(peekVersion({ bare: true })).toBeNull();
  });
});
