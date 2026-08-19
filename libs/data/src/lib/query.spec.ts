import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerSchema, resetSchemaRegistry, versioned } from '@skewkit/core';
import { memoryRecordDriver } from './memory-driver.js';
import { createRecordStore } from './record-store.js';
import { resetSharedInvalidators } from './invalidation.js';
import { createDataClient, type Query, type QueryState } from './query.js';

interface CharacterV1 {
  id: string;
  name: string;
}
interface CharacterV2 extends CharacterV1 {
  homeworld: string;
}

const CharacterV1Schema = versioned<CharacterV1>('character');
const CharacterV2Schema = versioned<CharacterV1>('character').next<CharacterV2>('add homeworld', {
  up: (v1) => ({ ...v1, homeworld: 'unknown' }),
  down: ({ homeworld: _h, ...rest }) => rest,
  derives: ['homeworld'],
  lossy: ['homeworld'],
});

/** Resolves once the query reaches a settled state, so tests never sleep on a guess. */
function settled<T>(query: Query<T>, predicate: (s: QueryState<T>) => boolean): Promise<QueryState<T>> {
  return new Promise((resolve) => {
    const stop = query.subscribe((state) => {
      if (!predicate(state)) return;
      queueMicrotask(() => stop());
      resolve(state);
    });
  });
}

const ready = <T>(query: Query<T>) => settled(query, (s) => s.status === 'ready' && !s.refreshing);

afterEach(() => {
  resetSchemaRegistry();
  resetSharedInvalidators();
});

describe('data client', () => {
  const client = (driver = memoryRecordDriver(), onFetch?: (key: string) => void) =>
    createDataClient({ driver, partition: () => 'tenant-a', ...(onFetch ? { onFetch } : {}) });

  it('fetches, stores, and reports the value', async () => {
    const c = client();
    const query = c.query({
      key: 'character:1',
      schema: CharacterV1Schema,
      fetch: async () => ({ id: '1', name: 'Luke' }),
    });

    const state = await ready(query);

    expect(state.data).toEqual({ id: '1', name: 'Luke' });
    expect(state.status).toBe('ready');
    query.dispose();
    c.close();
  });

  describe('the shared cache', () => {
    it('lets a second app read what the first fetched — one fetch between them', async () => {
      // The claim the demo makes. Two clients over one driver is two independently deployed apps
      // sharing an origin's storage.
      const driver = memoryRecordDriver();
      const fetches: string[] = [];
      const fetcher = vi.fn(async () => ({ id: '1', name: 'Luke' }));

      const appA = client(driver, (k) => fetches.push(`A:${k}`));
      const first = appA.query({ key: 'character:1', schema: CharacterV1Schema, fetch: fetcher });
      await ready(first);

      const appB = client(driver, (k) => fetches.push(`B:${k}`));
      const second = appB.query({
        key: 'character:1',
        schema: CharacterV1Schema,
        fetch: fetcher,
        staleWhileRevalidate: false,
      });
      const state = await ready(second);

      expect(state.data).toEqual({ id: '1', name: 'Luke' });
      expect(state.fromCache).toBe(true);
      expect(fetches).toEqual(['A:character:1']);
      expect(fetcher).toHaveBeenCalledTimes(1);

      first.dispose();
      second.dispose();
      appA.close();
      appB.close();
    });

    it('deduplicates simultaneous fetches across contexts', async () => {
      // An in-flight map cannot dedupe across realms, which are separate JavaScript contexts.
      // The per-key lock can, and the loser finds the record already written.
      const driver = memoryRecordDriver();
      let calls = 0;
      const fetcher = async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 20));
        return { id: '1', name: 'Luke' };
      };

      const appA = client(driver);
      const appB = client(driver);
      const a = appA.query({ key: 'character:1', schema: CharacterV1Schema, fetch: fetcher });
      const b = appB.query({ key: 'character:1', schema: CharacterV1Schema, fetch: fetcher });

      await Promise.all([ready(a), ready(b)]);

      expect(calls).toBe(1);
      a.dispose();
      b.dispose();
      appA.close();
      appB.close();
    });
  });

  describe('skew', () => {
    it('projects a stored record up to a newer reader, and says what was guessed', async () => {
      const driver = memoryRecordDriver();

      const old = client(driver);
      const v1 = old.query({
        key: 'character:1',
        schema: CharacterV1Schema,
        fetch: async () => ({ id: '1', name: 'Luke' }),
      });
      await ready(v1);

      // a second app, two versions ahead, reading the same bytes
      const modern = createDataClient({ driver, partition: () => 'tenant-a' });
      const v2 = modern.query({
        key: 'character:1',
        schema: CharacterV2Schema,
        fetch: async () => ({ id: '1', name: 'Luke', homeworld: 'Tatooine' }),
        staleWhileRevalidate: false,
      });
      const state = await ready(v2);

      expect(state.data).toEqual({ id: '1', name: 'Luke', homeworld: 'unknown' });
      expect(state.migratedFrom).toBe(1);
      expect(state.derivedPaths).toContain('homeworld');

      v1.dispose();
      v2.dispose();
      old.close();
      modern.close();
    });

    it('projects down for an older reader, reporting what was discarded', async () => {
      registerSchema(CharacterV2Schema);
      const driver = memoryRecordDriver();

      const modern = client(driver);
      const v2 = modern.query({
        key: 'character:1',
        schema: CharacterV2Schema,
        fetch: async () => ({ id: '1', name: 'Luke', homeworld: 'Tatooine' }),
      });
      await ready(v2);

      const old = createDataClient({ driver, partition: () => 'tenant-a' });
      const v1 = old.query({
        key: 'character:1',
        schema: CharacterV1Schema,
        fetch: async () => ({ id: '1', name: 'Luke' }),
        staleWhileRevalidate: false,
      });
      const state = await ready(v1);

      expect(state.data).toEqual({ id: '1', name: 'Luke' });
      expect(state.downgradedFrom).toBe(2);
      expect(state.lossyPaths).toContain('homeworld');

      v2.dispose();
      v1.dispose();
      modern.close();
      old.close();
    });
  });

  describe('invalidation', () => {
    it('refetches a query whose tag was invalidated', async () => {
      const driver = memoryRecordDriver();
      let name = 'Luke';
      const c = client(driver);
      const query = c.query({
        key: 'character:1',
        tags: ['character#1'],
        schema: CharacterV1Schema,
        fetch: async () => ({ id: '1', name }),
      });
      await ready(query);

      name = 'Luke Starkiller';
      c.invalidate('character#1');
      const state = await settled(query, (s) => s.data?.name === 'Luke Starkiller');

      expect(state.data?.name).toBe('Luke Starkiller');
      query.dispose();
      c.close();
    });

    it('reaches a query in another app on the same page', async () => {
      // Two clients each building a private invalidator is the outbox defect again: a page-wide
      // fact with a per-app answer. The mutating app never talks to the reading one — the tag does.
      const driver = memoryRecordDriver();
      let name = 'Luke';
      const fetcher = async () => ({ id: '1', name });

      const reader = createDataClient({ driver, partition: () => 'tenant-a' });
      const query = reader.query({
        key: 'character:1',
        tags: ['character#1'],
        schema: CharacterV1Schema,
        fetch: fetcher,
      });
      await ready(query);

      const mutator = createDataClient({ driver, partition: () => 'tenant-a' });
      name = 'Renamed';
      mutator.invalidate('character#1');

      expect((await settled(query, (s) => s.data?.name === 'Renamed')).data?.name).toBe('Renamed');

      query.dispose();
      reader.close();
      mutator.close();
    });

    it('does not reach another tenant', async () => {
      const driver = memoryRecordDriver();
      const fetcher = vi.fn(async () => ({ id: '1', name: 'Luke' }));

      const a = createDataClient({ driver, partition: () => 'tenant-a' });
      const query = a.query({ key: 'character:1', tags: ['character#1'], schema: CharacterV1Schema, fetch: fetcher });
      await ready(query);
      const before = fetcher.mock.calls.length;

      const b = createDataClient({ driver, partition: () => 'tenant-b' });
      b.invalidate('character#1');
      await new Promise((r) => setTimeout(r, 30));

      expect(fetcher).toHaveBeenCalledTimes(before);
      query.dispose();
      a.close();
      b.close();
    });

    it('leaves unrelated tags alone', async () => {
      const fetcher = vi.fn(async () => ({ id: '1', name: 'Luke' }));
      const c = client();
      const query = c.query({
        key: 'character:1',
        tags: ['character#1'],
        schema: CharacterV1Schema,
        fetch: fetcher,
      });
      await ready(query);
      const before = fetcher.mock.calls.length;

      c.invalidate('invoices');
      await new Promise((r) => setTimeout(r, 30));

      expect(fetcher).toHaveBeenCalledTimes(before);
      query.dispose();
      c.close();
    });
  });

  it('keeps showing cached data when a refresh fails', async () => {
    const driver = memoryRecordDriver();
    let fail = false;
    const c = client(driver);
    const query = c.query({
      key: 'character:1',
      schema: CharacterV1Schema,
      fetch: async () => {
        if (fail) throw new Error('offline');
        return { id: '1', name: 'Luke' };
      },
    });
    await ready(query);

    fail = true;
    await query.refetch();

    // stale beats blank, and `error` says which it is
    expect(query.current.data).toEqual({ id: '1', name: 'Luke' });
    expect(query.current.status).toBe('ready');
    expect(query.current.error).toBeDefined();
    query.dispose();
    c.close();
  });

  it('does not leak between tenants', async () => {
    const driver = memoryRecordDriver();
    let partition = 'tenant-a';
    const c = createDataClient({ driver, partition: () => partition });

    const a = c.query({ key: 'character:1', schema: CharacterV1Schema, fetch: async () => ({ id: '1', name: 'A' }) });
    await ready(a);
    a.dispose();

    partition = 'tenant-b';
    const b = c.query({ key: 'character:1', schema: CharacterV1Schema, fetch: async () => ({ id: '1', name: 'B' }) });
    const state = await ready(b);

    expect(state.data?.name).toBe('B');
    b.dispose();
    c.close();
  });
});


describe('a record this reader is too far behind to read', () => {
  /**
   * The `ahead` case: a record written by a newer build, with no down-migration to project it.
   * It is not corrupt and it is not missing — it is from the future — and the reader that cannot
   * read it should say so and refetch at its own version rather than guess at what it holds.
   */
  it('reports ahead and refetches at its own version instead of guessing', async () => {
    const driver = memoryRecordDriver();
    const partition = () => 'demo';

    interface V1 { id: string; name: string }
    interface V2 extends V1 { region: string }

    // The newer app's chain declares no `down`, so nothing can project its records backwards —
    // which is exactly what "retired" looks like to a reader two versions behind.
    const Newer = versioned<V1>('panel14-character').next<V2>('add region, no way back', (v1) => ({
      ...v1,
      region: 'outer rim',
    }));
    const Older = versioned<V1>('panel14-character');

    const newerStore = createRecordStore<V2>({ driver, collection: 'entities', schema: Newer });
    await newerStore.put({ id: 'c1', partition: partition(), value: { id: 'c1', name: 'Luke', region: 'core' } });

    const client = createDataClient({ driver, partition, collection: 'entities' });
    const fetched = vi.fn(async () => ({ id: 'c1', name: 'Luke from the network' }));

    const query = client.query<V1>({
      key: 'c1',
      schema: Older,
      fetch: fetched,
      staleWhileRevalidate: false,
    });

    const states: string[] = [];
    query.subscribe((state) => states.push(`${state.unreadable ?? '-'}:${state.data?.name ?? '-'}`));
    await settled(query, (state) => state.data !== undefined);

    // It said why before it went to the network, and it did go.
    expect(states.some((entry) => entry.startsWith('ahead:'))).toBe(true);
    expect(fetched).toHaveBeenCalledTimes(1);
    expect(query.current.data?.name).toBe('Luke from the network');
    // Once it has a value it can read, nothing is outstanding.
    expect(query.current.unreadable).toBeNull();

    query.dispose();
    client.close();
  });
});
