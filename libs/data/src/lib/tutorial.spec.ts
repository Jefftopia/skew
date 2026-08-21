import { afterEach, describe, expect, it } from 'vitest';
import { versioned } from '@braidlabs/skew';
import { memoryRecordDriver } from './memory-driver.js';
import { createRecordStore } from './record-store.js';
import { createDataClient } from './query.js';
import { resetSharedInvalidators } from './invalidation.js';
import { createOutbox } from './outbox.js';
import { createTenancy } from './tenancy.js';
import type { PushSink } from './adapters.js';

/**
 * The examples from `docs/tutorials/04-data-storage.md`, executed.
 *
 * A tutorial whose snippets do not run is worse than no tutorial: the reader assumes they made the
 * mistake. These follow the tutorial's steps in order and use its exact shapes, so a change that
 * breaks the walkthrough fails here first.
 */

// Step 1 — describe your data with a version
interface Note {
  id: string;
  title: string;
}
const NoteContract = versioned<Note>('note');

afterEach(() => resetSharedInvalidators());

describe('tutorial 6', () => {
  it('step 2–3: opens a store, writes, and reads back', async () => {
    const driver = memoryRecordDriver();
    const notes = createRecordStore({ driver, collection: 'notes', schema: NoteContract });

    await notes.put({ id: 'n1', partition: 'default', value: { id: 'n1', title: 'Buy milk' } });
    const note = await notes.get('n1', 'default');

    expect(note?.value.title).toBe('Buy milk');
  });

  it('step 3: a partition is a boundary, as the tutorial claims', async () => {
    const driver = memoryRecordDriver();
    const notes = createRecordStore({ driver, collection: 'notes', schema: NoteContract });
    await notes.put({ id: 'n1', partition: 'tenant-a', value: { id: 'n1', title: 'A' } });

    expect(await notes.get('n1', 'tenant-b')).toBeNull();
  });

  it('step 4: a query serves the cache and reports where the value came from', async () => {
    const driver = memoryRecordDriver();
    const data = createDataClient({ driver, partition: () => 'default', collection: 'notes' });

    const first = data.query({
      key: 'note:n1',
      tags: ['note#n1', 'notes'],
      schema: NoteContract,
      fetch: async () => ({ id: 'n1', title: 'Buy milk' }),
    });
    await settled(first, (s) => s.status === 'ready' && !s.refreshing);

    const second = data.query({
      key: 'note:n1',
      schema: NoteContract,
      fetch: async () => ({ id: 'n1', title: 'Buy milk' }),
      staleWhileRevalidate: false,
    });
    const state = await settled(second, (s) => s.status === 'ready');

    expect(state.data?.title).toBe('Buy milk');
    expect(state.fromCache).toBe(true);

    first.dispose();
    second.dispose();
    data.close();
  });

  it('step 5: invalidating a tag refetches the queries that declared it', async () => {
    const driver = memoryRecordDriver();
    const data = createDataClient({ driver, partition: () => 'default', collection: 'notes' });
    let title = 'Buy milk';

    const note = data.query({
      key: 'note:n1',
      tags: ['note#n1', 'notes'],
      schema: NoteContract,
      fetch: async () => ({ id: 'n1', title }),
    });
    await settled(note, (s) => s.status === 'ready' && !s.refreshing);

    title = 'Buy oat milk';
    data.invalidate('note#n1');

    expect((await settled(note, (s) => s.data?.title === 'Buy oat milk')).data?.title).toBe('Buy oat milk');
    note.dispose();
    data.close();
  });

  it('step 5: the wildcard row in the tag table is real', async () => {
    const driver = memoryRecordDriver();
    const data = createDataClient({ driver, partition: () => 'default', collection: 'notes' });
    let title = 'Buy milk';

    const note = data.query({
      key: 'note:n1',
      tags: ['note#n1'],
      schema: NoteContract,
      fetch: async () => ({ id: 'n1', title }),
    });
    await settled(note, (s) => s.status === 'ready' && !s.refreshing);

    title = 'Buy oat milk';
    data.invalidate('note#*');

    expect((await settled(note, (s) => s.data?.title === 'Buy oat milk')).data?.title).toBe('Buy oat milk');
    note.dispose();
    data.close();
  });

  it('step 7: the drain loop the tutorial prints works as written', async () => {
    const driver = memoryRecordDriver();
    const outbox = createOutbox({ driver, owner: 'notes-app' });
    await outbox.enqueue({ mutationId: 'note.rename', input: { id: 'n1', title: 'Buy oat milk' } });

    const sent: unknown[] = [];
    let failures = 0;
    const send = async (input: unknown) => {
      if (failures++ < 1) throw new Error('offline');
      sent.push(input);
    };

    // two passes: the first fails and keeps the entry, the second sends it
    for (let pass = 0; pass < 2; pass++) {
      for (const entry of await outbox.mine()) {
        try {
          await send(entry.input);
          await outbox.remove(entry.id);
        } catch (error) {
          const attempts = await outbox.recordFailure(entry.id, String(error));
          if (attempts >= 5) await outbox.remove(entry.id);
          break;
        }
      }
    }

    expect(sent).toEqual([{ id: 'n1', title: 'Buy oat milk' }]);
    expect(await outbox.mine()).toEqual([]);
  });

  it('step 7: you only ever see your own entries', async () => {
    const driver = memoryRecordDriver();
    const mine = createOutbox({ driver, owner: 'notes-app' });
    const theirs = createOutbox({ driver, owner: 'other-app' });

    await mine.enqueue({ mutationId: 'note.rename', input: {} });
    await theirs.enqueue({ mutationId: 'invoice.save', input: {} });

    expect((await mine.mine()).map((e) => e.mutationId)).toEqual(['note.rename']);
    expect((await mine.foreign()).map((e) => e.mutationId)).toEqual(['invoice.save']);
    expect(await mine.all()).toHaveLength(2);
  });

  it('step 8: the durable/volatile comparison prints what the tutorial says', async () => {
    // The whole point of `persistOutbox`. A shared driver stands in for storage that survives a
    // reload; a fresh memory driver stands in for one that does not.
    const persistentStorage = memoryRecordDriver();

    const durable = createOutbox({ driver: persistentStorage, owner: 'demo' });
    const volatile = createOutbox({ driver: memoryRecordDriver(), owner: 'demo' });

    await durable.enqueue({ mutationId: 'note.rename', input: { id: 'n1' } });
    await volatile.enqueue({ mutationId: 'note.rename', input: { id: 'n1' } });

    expect(await durable.mine()).toHaveLength(1);
    expect(await volatile.mine()).toHaveLength(1);

    // the reload: storage persists, memory does not
    const afterReloadDurable = createOutbox({ driver: persistentStorage, owner: 'demo' });
    const afterReloadVolatile = createOutbox({ driver: memoryRecordDriver(), owner: 'demo' });

    expect(await afterReloadDurable.mine()).toHaveLength(1);
    expect(await afterReloadVolatile.mine()).toHaveLength(0);
  });

  it('step 5 and 7: mutate queues, keeps the change on screen, and replays it', async () => {
    const driver = memoryRecordDriver();
    const data = createDataClient({
      driver,
      partition: () => 'demo',
      collection: 'notes',
      outbox: createOutbox({ driver, owner: 'notes-app' }),
      autoFlush: false,
    });

    // A record to change, as a fetched query would have left it.
    const notes = createRecordStore({ driver, collection: 'notes', schema: NoteContract });
    await notes.put({ id: 'note:n1', partition: 'demo', value: { id: 'n1', title: 'Oat milk' } });

    let online = false;
    const send = async (input: unknown) => {
      if (!online) throw new TypeError('Failed to fetch');
      return input;
    };

    const outcome = await data.mutate({
      key: 'note:n1',
      schema: NoteContract,
      mutationId: 'note.rename',
      input: { id: 'n1', title: 'Buy oat milk' },
      patch: { title: 'Buy oat milk' },
      tags: ['note#n1'],
      send,
    });

    expect(outcome.status).toBe('queued');

    const query = data.query<Note>({
      key: 'note:n1',
      schema: NoteContract,
      fetch: async () => ({ id: 'n1', title: 'Oat milk' }),
      staleWhileRevalidate: false,
    });
    const pending = await settled(query, (state: { data?: Note }) => state.data !== undefined);

    // The change is on screen while it waits, which is what the tutorial promises.
    expect((pending as { data: Note }).data.title).toBe('Buy oat milk');

    online = true;
    expect((await data.flush()).sent).toBe(1);

    query.dispose();
    data.close();
  });

  it('step 7: an entry with no registered runner is kept, not dropped', async () => {
    const driver = memoryRecordDriver();
    const first = createDataClient({
      driver,
      partition: () => 'demo',
      collection: 'notes',
      outbox: createOutbox({ driver, owner: 'notes-app' }),
      autoFlush: false,
    });
    await first.mutate({
      key: 'note:n1',
      schema: NoteContract,
      mutationId: 'note.rename',
      input: { id: 'n1', title: 'Buy oat milk' },
      patch: { title: 'Buy oat milk' },
      send: async () => {
        throw new TypeError('Failed to fetch');
      },
    });
    first.close();

    // The reload the tutorial warns about: register your mutation kinds, or nothing can replay them.
    const reported: string[] = [];
    const second = createDataClient({
      driver,
      partition: () => 'demo',
      collection: 'notes',
      outbox: createOutbox({ driver, owner: 'notes-app' }),
      onFlushError: (message) => reported.push(message),
      autoFlush: false,
    });

    expect((await second.flush()).remaining).toBe(1);
    expect(reported[0]).toContain('no registered mutation');

    second.registerMutation('note.rename', async (input) => input);
    expect((await second.flush()).sent).toBe(1);

    second.close();
  });

  it('step 10: signing in, switching, and signing out do what the tutorial says', async () => {
    const driver = memoryRecordDriver();
    const tenancy = createTenancy({ driver, collections: ['entities', 'outbox'] });

    await tenancy.signIn({ userId: 'u-1', actingAs: 'household-a' });
    const notes = createRecordStore({ driver, collection: 'entities', schema: NoteContract });
    const householdA = tenancy.partition();
    await notes.put({ id: 'n1', partition: householdA, value: { id: 'n1', title: 'A' } });

    // a pointer move — household-a stays warm on disk
    const householdB = await tenancy.switchTenant('household-b');
    expect(householdB).not.toBe(householdA);
    expect(await notes.get('n1', householdA)).not.toBeNull();

    await tenancy.signOut();
    expect(await notes.get('n1', householdA)).toBeNull();
    // refused, not emptied: an empty answer is indistinguishable from a user with no data
    expect(() => tenancy.partition()).toThrow();
  });

  it('step 11: a pushed record is enveloped and refreshes readers from storage', async () => {
    const driver = memoryRecordDriver();
    const client = createDataClient({ driver, partition: () => 'demo', collection: 'notes' });

    let fetches = 0;
    const query = client.query<Note>({
      key: 'note:1',
      schema: NoteContract,
      fetch: async () => {
        fetches += 1;
        return { id: '1', title: 'from the server' };
      },
      staleWhileRevalidate: false,
    });
    await settled(query, (state) => state.data !== undefined);

    let sink!: PushSink;
    const disconnect = client.connect({
      schema: NoteContract,
      source: (given) => void (sink = given),
    });
    await sink.receive({ key: 'note:1', value: { id: '1', title: 'pushed' } });
    const state = await settled(query, (s) => s.data?.title === 'pushed');

    expect(state.data).toEqual({ id: '1', title: 'pushed' });
    // the push already is the newest thing anyone has
    expect(fetches).toBe(1);

    disconnect();
    query.dispose();
    client.close();
  });
});

function settled<T>(
  query: { subscribe(l: (s: T) => void): () => void },
  predicate: (state: T) => boolean,
): Promise<T> {
  return new Promise((resolve) => {
    const stop = query.subscribe((state) => {
      if (!predicate(state)) return;
      queueMicrotask(() => stop());
      resolve(state);
    });
  });
}
