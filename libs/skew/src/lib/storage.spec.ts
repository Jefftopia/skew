import { describe, expect, it, vi } from 'vitest';
import { createVersionedStore, memoryDriver, webStorageDriver } from './storage.js';
import { versioned } from './versioned.js';

interface V1 {
  id: string;
  quote?: string;
}
interface V2 {
  id: string;
  scripture?: string;
}

const Schema = versioned<V1>('weekly').next<V2>('rename quote', (p) => ({
  id: p.id,
  scripture: p.quote,
}));

describe('createVersionedStore', () => {
  it('round-trips a value', async () => {
    const store = createVersionedStore(Schema, { driver: memoryDriver() });

    await store.set('2026-12-06', { id: 'a', scripture: 'Prepare the way' });
    const result = await store.get('2026-12-06');

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.scripture).toBe('Prepare the way');
  });

  it('namespaces keys by schema name', async () => {
    const map = new Map<string, string>();
    const store = createVersionedStore(Schema, { driver: memoryDriver(map) });

    await store.set('k', { id: 'a' });

    expect(store.keyFor('k')).toBe('weekly:k');
    expect([...map.keys()]).toEqual(['weekly:k']);
  });

  it('migrates data written under an older schema', async () => {
    const map = new Map<string, string>();
    // Simulate a record written before the rename.
    map.set('weekly:old', JSON.stringify({ v: 1, payload: { id: 'a', quote: 'Comfort' } }));
    const store = createVersionedStore(Schema, { driver: memoryDriver(map) });

    const result = await store.get('old');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.migratedFrom).toBe(1);
      expect(result.value.scripture).toBe('Comfort');
    }
  });

  it('migrates un-enveloped legacy records', async () => {
    const map = new Map<string, string>();
    map.set('weekly:legacy', JSON.stringify({ id: 'a', quote: 'Rejoice' }));
    const store = createVersionedStore(Schema, { driver: memoryDriver(map) });

    const result = await store.get('legacy');

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.scripture).toBe('Rejoice');
  });

  it('surfaces data from a newer build instead of discarding it', async () => {
    const map = new Map<string, string>();
    map.set('weekly:future', JSON.stringify({ v: 99, payload: { id: 'a' } }));
    const onReadFailure = vi.fn();
    const store = createVersionedStore(Schema, { driver: memoryDriver(map), onReadFailure });

    const result = await store.get('future');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('ahead');
    expect(onReadFailure).toHaveBeenCalledOnce();
  });

  it('reports malformed JSON rather than throwing', async () => {
    const map = new Map<string, string>([['weekly:bad', '{not json']]);
    const store = createVersionedStore(Schema, { driver: memoryDriver(map) });

    const result = await store.get('bad');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid');
  });

  it('reports a miss for an absent key', async () => {
    const store = createVersionedStore(Schema, { driver: memoryDriver() });
    expect((await store.get('nope')).ok).toBe(false);
  });

  it('stamps build identity when configured', async () => {
    const map = new Map<string, string>();
    const store = createVersionedStore(Schema, { driver: memoryDriver(map), buildId: 'build-7' });

    await store.set('k', { id: 'a' });

    expect(JSON.parse(map.get('weekly:k') as string).b).toBe('build-7');
  });

  it('removes values', async () => {
    const store = createVersionedStore(Schema, { driver: memoryDriver() });
    await store.set('k', { id: 'a' });
    await store.remove('k');
    expect((await store.get('k')).ok).toBe(false);
  });

  describe('peek', () => {
    it('reads synchronously on a sync driver', async () => {
      const store = createVersionedStore(Schema, { driver: memoryDriver() });
      await store.set('k', { id: 'a', scripture: 's' });

      const result = store.peek('k');

      expect(result?.ok).toBe(true);
      if (result?.ok) expect(result.value.scripture).toBe('s');
    });

    it('returns null on an async driver rather than lying', async () => {
      const asyncDriver = { ...memoryDriver(), sync: false };
      const store = createVersionedStore(Schema, { driver: asyncDriver });

      expect(store.peek('k')).toBeNull();
    });
  });
});

describe('webStorageDriver', () => {
  it('falls back to memory when storage is unavailable', async () => {
    const driver = webStorageDriver('local', {});
    expect(driver.sync).toBe(true);
    await driver.set('a', '1');
    expect(await driver.get('a')).toBe('1');
  });

  it('falls back to memory when storage throws (private mode)', async () => {
    const hostile = {
      setItem: () => {
        throw new Error('QuotaExceeded');
      },
      getItem: () => null,
      removeItem: () => undefined,
    } as unknown as Storage;

    const driver = webStorageDriver('local', { localStorage: hostile });

    await driver.set('a', '1');
    expect(await driver.get('a')).toBe('1'); // served from the memory fallback
  });

  it('swallows quota errors on write without breaking the caller', async () => {
    let calls = 0;
    const store: Storage = {
      getItem: () => null,
      setItem: () => {
        // usable-probe succeeds, later writes fail
        if (++calls > 1) throw new Error('QuotaExceeded');
      },
      removeItem: () => undefined,
    } as unknown as Storage;

    const driver = webStorageDriver('local', { localStorage: store });
    // A sync driver returns void, not a promise — the point is that a full
    // cache does not blow up a write the user asked for.
    expect(() => driver.set('k', 'v')).not.toThrow();
  });
});
