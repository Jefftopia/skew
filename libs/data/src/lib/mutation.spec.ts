import { afterEach, describe, expect, it } from 'vitest';
import { versioned } from '@braid/skew';
import { memoryRecordDriver } from './memory-driver.js';
import { resetSharedInvalidators } from './invalidation.js';
import { createOutbox } from './outbox.js';
import { createDataClient, type Query, type QueryState } from './query.js';

/**
 * The optimistic overlay: `view = confirmed ⊕ pending`.
 *
 * The tests that matter here are the ones about *derivation*. An overlay that were stored would
 * pass a happy-path test just as well and then disagree with the queue the first time a send
 * failed — so the cases below are mostly about what a second reader, a failed send, and a reload
 * see, which is where a stored overlay goes wrong.
 */

interface Character {
  id: string;
  name: string;
  homeworld: string;
}

const CharacterSchema = versioned<Character>('mutation-spec-character');

function settled(query: Query<Character>, predicate: (s: QueryState<Character>) => boolean): Promise<QueryState<Character>> {
  return new Promise((resolve) => {
    const stop = query.subscribe((state) => {
      if (!predicate(state)) return;
      queueMicrotask(() => stop());
      resolve(state);
    });
  });
}

const ready = (query: Query<Character>) => settled(query, (s) => s.status === 'ready' && !s.refreshing);

/** A deferred send, so a test can hold a mutation in flight and look at the page meanwhile. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const LUKE: Character = { id: '1', name: 'Luke Skywalker', homeworld: 'Tatooine' };

afterEach(() => resetSharedInvalidators());

describe('the optimistic overlay', () => {
  const setup = (driver = memoryRecordDriver(), owner = 'host') => {
    const outbox = createOutbox({ driver, owner });
    const client = createDataClient({ driver, partition: () => 'tenant-a', outbox });
    const query = () =>
      client.query<Character>({
        key: 'character:1',
        tags: ['character#1'],
        schema: CharacterSchema,
        fetch: async () => LUKE,
        staleWhileRevalidate: false,
      });
    return { driver, outbox, client, query };
  };

  const rename = (name: string) => ({
    key: 'character:1',
    schema: CharacterSchema,
    mutationId: 'character.rename',
    input: { id: '1', name },
    patch: { name },
  });

  it('shows the edit before the server has answered, marked pending', async () => {
    const { client, query } = setup();
    const view = query();
    await ready(view);

    const send = deferred<Character>();
    const mutating = client.mutate<Character>({ ...rename('Luke Starkiller'), send: () => send.promise });

    const optimistic = await settled(view, (s) => s.pending);
    expect(optimistic.data?.name).toBe('Luke Starkiller');

    send.resolve({ ...LUKE, name: 'Luke Starkiller' });
    await mutating;

    const confirmed = await settled(view, (s) => !s.pending);
    expect(confirmed.data?.name).toBe('Luke Starkiller');
    expect(confirmed.conflict).toBeNull();

    view.dispose();
    client.close();
  });

  it('shows one app the edit another app has not sent yet', async () => {
    // The overlay is derived from shared storage, so it is not a property of the app that typed it.
    const driver = memoryRecordDriver();
    const writer = setup(driver, 'host');
    const reader = setup(driver, 'billing');

    const writerView = writer.query();
    const readerView = reader.query();
    await Promise.all([ready(writerView), ready(readerView)]);

    const send = deferred<Character>();
    void writer.client.mutate<Character>({ ...rename('Luke Starkiller'), send: () => send.promise });

    const seenByReader = await settled(readerView, (s) => s.pending);
    expect(seenByReader.data?.name).toBe('Luke Starkiller');

    send.resolve({ ...LUKE, name: 'Luke Starkiller' });
    writerView.dispose();
    readerView.dispose();
    writer.client.close();
    reader.client.close();
  });

  it('keeps the edit applied and the entry queued when the send fails', async () => {
    const { client, outbox, query } = setup();
    const view = query();
    await ready(view);

    const outcome = await client.mutate<Character>({
      ...rename('Luke Starkiller'),
      send: async () => {
        throw new Error('offline');
      },
    });

    expect(outcome.status).toBe('queued');

    const queued = await settled(view, (s) => s.pending);
    expect(queued.data?.name).toBe('Luke Starkiller');
    expect(await outbox.mine()).toHaveLength(1);

    view.dispose();
    client.close();
  });

  it('rebuilds the overlay after a reload, from the queue alone', async () => {
    const driver = memoryRecordDriver();
    const before = setup(driver);
    const first = before.query();
    await ready(first);
    await before.client.mutate<Character>({
      ...rename('Luke Starkiller'),
      send: async () => {
        throw new Error('offline');
      },
    });
    first.dispose();
    before.client.close();

    // A new client over the same storage: no closure survived, and neither did any in-memory state.
    const after = setup(driver);
    const reloaded = after.query();
    const state = await ready(reloaded);

    expect(state.pending).toBe(true);
    expect(state.data?.name).toBe('Luke Starkiller');

    reloaded.dispose();
    after.client.close();
  });

  it('shows a record gone before the delete has been sent', async () => {
    // A patch cannot express absence, so a deletion carries the fact. Without it the row stays on
    // screen after the user removed it, which reads as the delete having failed.
    const { client, query } = setup();
    const view = query();
    await ready(view);

    void client.mutate<Character>({
      key: 'character:1',
      schema: CharacterSchema,
      mutationId: 'character.delete',
      input: { id: '1' },
      patch: {},
      removes: true,
      send: async () => {
        throw new Error('offline');
      },
    });

    const state = await settled(view, (s) => s.pending);
    expect(state.data).toBeUndefined();

    view.dispose();
    client.close();
  });

  it('drops the overlay when the entry is removed, with no undo record', async () => {
    const { client, outbox, query } = setup();
    const view = query();
    await ready(view);

    const outcome = await client.mutate<Character>({
      ...rename('Luke Starkiller'),
      send: async () => {
        throw new Error('offline');
      },
    });
    await settled(view, (s) => s.pending);

    await outbox.remove(outcome.entryId);
    client.invalidate('character#1');

    const rolledBack = await settled(view, (s) => !s.pending);
    expect(rolledBack.data?.name).toBe('Luke Skywalker');

    view.dispose();
    client.close();
  });
});

describe('conflict on confirmation', () => {
  const setup = () => {
    const driver = memoryRecordDriver();
    const outbox = createOutbox({ driver, owner: 'host' });
    const client = createDataClient({ driver, partition: () => 'tenant-a', outbox });
    const query = () =>
      client.query<Character>({
        key: 'character:1',
        schema: CharacterSchema,
        fetch: async () => LUKE,
        staleWhileRevalidate: false,
      });
    return { client, query };
  };

  /** The server accepts the write and stores something else — the case the default exists for. */
  const rewritten = { ...LUKE, name: 'LUKE STARKILLER' };
  const base = {
    key: 'character:1',
    schema: CharacterSchema,
    mutationId: 'character.rename',
    input: { id: '1', name: 'Luke Starkiller' },
    patch: { name: 'Luke Starkiller' },
    send: async () => rewritten,
  };

  it('raises by default, reporting both values', async () => {
    const { client, query } = setup();
    const view = query();
    await ready(view);

    const outcome = await client.mutate<Character>(base);

    expect(outcome.conflict).toEqual({
      expected: { ...LUKE, name: 'Luke Starkiller' },
      actual: rewritten,
      paths: ['name'],
    });

    const state = await settled(view, (s) => s.conflict !== null);
    // The stored record is the server's: there is no client-wins option, only whether we say so.
    expect(state.data?.name).toBe('LUKE STARKILLER');
    expect(state.pending).toBe(false);

    client.acknowledgeConflict('character:1');
    const dismissed = await settled(view, (s) => s.conflict === null);
    expect(dismissed.data?.name).toBe('LUKE STARKILLER');

    view.dispose();
    client.close();
  });

  it('stays silent under "accept"', async () => {
    const { client, query } = setup();
    const view = query();
    await ready(view);

    const outcome = await client.mutate<Character>({ ...base, onConflict: 'accept' });

    expect(outcome.conflict).toBeUndefined();
    expect(outcome.value?.name).toBe('LUKE STARKILLER');
    expect(view.current.conflict).toBeNull();

    view.dispose();
    client.close();
  });

  it('stores what a resolver returns, and raises nothing', async () => {
    const { client, query } = setup();
    const view = query();
    await ready(view);

    const outcome = await client.mutate<Character>({
      ...base,
      onConflict: ({ expected, actual }) => ({ ...actual, homeworld: expected.homeworld }),
    });

    expect(outcome.conflict).toBeUndefined();
    expect(outcome.value).toEqual({ ...rewritten, homeworld: 'Tatooine' });

    view.dispose();
    client.close();
  });

  it('does not raise when the server touched a field the write did not', async () => {
    // Agreement is about the patched paths. Reporting every server-side edit as a conflict trains
    // users to dismiss the ones that matter.
    const { client, query } = setup();
    const view = query();
    await ready(view);

    const outcome = await client.mutate<Character>({
      ...base,
      send: async () => ({ ...LUKE, name: 'Luke Starkiller', homeworld: 'Polis Massa' }),
    });

    expect(outcome.conflict).toBeUndefined();
    expect(outcome.value?.homeworld).toBe('Polis Massa');

    view.dispose();
    client.close();
  });

  it('refuses to mutate without an outbox, naming why', async () => {
    const client = createDataClient({ driver: memoryRecordDriver(), partition: () => 'tenant-a' });

    await expect(client.mutate<Character>(base)).rejects.toThrow(/needs an `outbox`/);

    client.close();
  });
});
