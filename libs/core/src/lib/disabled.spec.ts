import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { versioned } from './versioned.js';
import { createVersionedStore, memoryDriver } from './storage.js';
import { isSkewDisabled, setSkewDisabled } from './disabled.js';

/**
 * The switch is undocumented, not untested.
 *
 * These assert the *failure modes it re-enables*, because that is what the
 * demos rely on it to produce. If disabling stopped actually breaking things,
 * the before/after comparison would quietly become theatre — which is the one
 * outcome worse than not having the switch at all.
 */

interface V1 {
  id: string;
  author: string;
}

interface V2 {
  id: string;
  author: { name: string; email: string };
}

const Schema = versioned<V1>('disabled-spec').next<V2>(
  'structure the author',
  (v1) => ({
    id: v1.id,
    author: { name: v1.author, email: '' },
  }),
);

describe('setSkewDisabled', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    // A leaked flag would silently disable protections in every later test.
    setSkewDisabled(false);
    vi.restoreAllMocks();
  });

  it('defaults to off', () => {
    expect(isSkewDisabled()).toBe(false);
  });

  it('warns the first time it is turned on', () => {
    setSkewDisabled(true);
    expect(console.warn).toHaveBeenCalledOnce();
    expect(vi.mocked(console.warn).mock.calls[0]?.[0]).toContain(
      'PROTECTIONS DISABLED',
    );
  });

  it('does not warn again while already on', () => {
    setSkewDisabled(true);
    setSkewDisabled(true);
    expect(console.warn).toHaveBeenCalledOnce();
  });

  describe('when disabled', () => {
    it('writes a bare payload, so nothing records which build authored it', async () => {
      const driver = memoryDriver();
      const store = createVersionedStore(Schema, {
        driver,
        buildId: 'build-1',
      });

      setSkewDisabled(true);
      await store.set('k', { id: 'a', author: { name: 'Ada', email: '' } });

      const raw = JSON.parse((await driver.get('disabled-spec:k')) as string);
      expect(raw).toEqual({ id: 'a', author: { name: 'Ada', email: '' } });
      expect(raw).not.toHaveProperty('v');
      expect(raw).not.toHaveProperty('b');
    });

    it('hands back data from a newer build as though it were current', () => {
      // The record says v2. This schema is v2 — but pretend the reader is older
      // by asking a v1-only schema to read it.
      const older = versioned<V1>('disabled-spec');
      const fromNewerBuild = {
        v: 2,
        payload: { id: 'a', author: { name: 'Ada', email: '' } },
      };

      const guarded = older.read(fromNewerBuild);
      expect(guarded.ok).toBe(false);
      expect(guarded.ok === false && guarded.reason).toBe('ahead');

      setSkewDisabled(true);
      const unguarded = older.read(fromNewerBuild);

      // No failure, and the caller now holds the envelope itself typed as V1 —
      // `author` is not even where the reader expects it. This is exactly the
      // `undefined` deep in a renderer that the envelope prevents.
      expect(unguarded.ok).toBe(true);
      expect(unguarded.ok && (unguarded.value as unknown)).toEqual(
        fromNewerBuild,
      );
      expect(unguarded.ok && (unguarded.value as V1).author).toBeUndefined();
    });

    it('skips the migration, so an old record keeps its old shape', () => {
      const legacy = { id: 'a', author: 'Ada' };

      const guarded = Schema.read(legacy);
      expect(guarded.ok && guarded.value.author).toEqual({
        name: 'Ada',
        email: '',
      });

      setSkewDisabled(true);
      const unguarded = Schema.read(legacy);

      // A string where the current code expects `{ name, email }`.
      expect(unguarded.ok).toBe(true);
      expect(unguarded.ok && (unguarded.value.author as unknown)).toBe('Ada');
    });

    it('reports success for data that is not readable at all', () => {
      setSkewDisabled(true);
      const result = Schema.read(null);
      expect(result.ok).toBe(true);
    });
  });

  it('restores every protection when turned back off', () => {
    setSkewDisabled(true);
    setSkewDisabled(false);

    const result = versioned<V1>('disabled-spec').read({ v: 2, payload: {} });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe('ahead');
  });
});
