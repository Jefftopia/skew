import { versioned } from '@skewkit/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInvalidator, resetSharedInvalidators, type BroadcastChannelLike } from './invalidation.js';
import { memoryRecordDriver } from './memory-driver.js';
import { createOutbox } from './outbox.js';
import { partitionKey } from './tenancy.js';
import { createDataClient, type Query, type QueryState } from './query.js';

/**
 * Two fragments, one origin — the setup from `07-storefront.md`'s composition section.
 *
 * Braid puts each fragment in its own realm, which is its own JavaScript context. Everything below
 * turns on that one fact: storage is shared because the origin is shared, and memory is not shared
 * because the contexts are not. Each test here is a claim that section makes.
 */

interface Customer {
  id: string;
  name: string;
}

const CustomerContract = versioned<Customer>('shop.customer');

/** A pair of channels wired to each other — one page, two realms. */
function realmChannels(): [BroadcastChannelLike, BroadcastChannelLike] {
  const listeners: Array<Set<(event: { data: unknown }) => void>> = [new Set(), new Set()];

  const make = (self: number, other: number): BroadcastChannelLike => ({
    // A real BroadcastChannel never delivers to its own sender, which is exactly the semantics the
    // invalidator relies on: local subscribers are notified directly, remote ones over the channel.
    postMessage: (message) => listeners[other]!.forEach((listener) => listener({ data: message })),
    addEventListener: (_type, listener) => void listeners[self]!.add(listener),
    close: () => listeners[self]!.clear(),
  });

  return [make(0, 1), make(1, 0)];
}

const settled = <T>(query: Query<T>, predicate: (state: QueryState<T>) => boolean) =>
  new Promise<QueryState<T>>((resolve) => {
    const stop = query.subscribe((state) => {
      if (!predicate(state)) return;
      queueMicrotask(() => {
        stop();
        resolve(state);
      });
    });
  });

afterEach(() => resetSharedInvalidators());

describe('agreeing on the partition without coordinating', () => {
  it('derives the same partition from the same identity, in any fragment', () => {
    // No fragment has to ask another where to read. Same principal in, same partition out — which
    // is what lets independently deployed apps land in one place with no shared state.
    expect(partitionKey('user:ana', 'acme')).toBe(partitionKey('user:ana', 'acme'));
    expect(partitionKey('user:ana', 'acme')).not.toBe(partitionKey('user:ana', 'globex'));
  });
});

describe('the shared cache', () => {
  it('lets one fragment serve what another fetched', async () => {
    const driver = memoryRecordDriver();
    const partition = () => partitionKey('user:ana');

    // Two clients over one driver: two independently deployed apps sharing an origin's storage.
    const billing = createDataClient({ driver, partition, collection: 'entities' });
    const profile = createDataClient({ driver, partition, collection: 'entities' });

    const fetches = vi.fn(async () => ({ id: 'c1', name: 'Ana' }));
    const definition = {
      key: 'customer:c1',
      schema: CustomerContract,
      fetch: fetches,
      staleWhileRevalidate: false,
    };

    const first = billing.query<Customer>(definition);
    await settled(first, (state) => state.data !== undefined);

    const second = profile.query<Customer>(definition);
    const state = await settled(second, (s) => s.data !== undefined);

    expect(state.data?.name).toBe('Ana');
    expect(state.fromCache).toBe(true);
    expect(fetches).toHaveBeenCalledTimes(1);

    first.dispose();
    second.dispose();
    billing.close();
    profile.close();
  });
});

describe('invalidation across realms', () => {
  it('does not reach another context without the channel', async () => {
    const driver = memoryRecordDriver();
    const partition = () => partitionKey('user:ana');

    // Two *separate* invalidators, as two realms have: each context has its own module state, so
    // there is no shared map for them to meet in.
    const billing = createDataClient({
      driver,
      partition,
      collection: 'entities',
      invalidator: createInvalidator({ partition: 'p' }),
    });
    const profile = createDataClient({
      driver,
      partition,
      collection: 'entities',
      invalidator: createInvalidator({ partition: 'p' }),
    });

    const refetches = vi.fn(async () => ({ id: 'c1', name: 'Ana' }));
    const watching = profile.query<Customer>({
      key: 'customer:c1',
      tags: ['customer#c1'],
      schema: CustomerContract,
      fetch: refetches,
      staleWhileRevalidate: false,
    });
    await settled(watching, (state) => state.data !== undefined);
    const before = refetches.mock.calls.length;

    billing.invalidate('customer#c1');
    await new Promise((resolve) => setTimeout(resolve, 10));

    // This is the trap the composition section exists to warn about: staleness is invisible, so a
    // fragment that never hears about a change looks like it is working.
    expect(refetches.mock.calls.length).toBe(before);

    watching.dispose();
    billing.close();
    profile.close();
  });

  it('reaches another context once the channel is on', async () => {
    const driver = memoryRecordDriver();
    const partition = () => partitionKey('user:ana');
    const [channelOne, channelTwo] = realmChannels();

    const billing = createDataClient({
      driver,
      partition,
      collection: 'entities',
      invalidator: createInvalidator({ partition: 'p', crossContext: true, channel: channelOne }),
    });
    const profile = createDataClient({
      driver,
      partition,
      collection: 'entities',
      invalidator: createInvalidator({ partition: 'p', crossContext: true, channel: channelTwo }),
    });

    const refetches = vi.fn(async () => ({ id: 'c1', name: 'Ana' }));
    const watching = profile.query<Customer>({
      key: 'customer:c1',
      tags: ['customer#c1'],
      schema: CustomerContract,
      fetch: refetches,
      staleWhileRevalidate: false,
    });
    await settled(watching, (state) => state.data !== undefined);
    const before = refetches.mock.calls.length;

    billing.invalidate('customer#c1');
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(refetches.mock.calls.length).toBeGreaterThan(before);

    watching.dispose();
    billing.close();
    profile.close();
  });
});

describe('queued work stays with the fragment that made it', () => {
  it('never replays or reports another fragment\'s entries as its own', async () => {
    const driver = memoryRecordDriver();

    // One queue in shared storage; two owners.
    const billing = createOutbox({ driver, owner: 'billing', collection: 'outbox' });
    const profile = createOutbox({ driver, owner: 'profile', collection: 'outbox' });

    await billing.enqueue({ mutationId: 'invoice.pay', input: { id: 'i1' } });
    await profile.enqueue({ mutationId: 'profile.rename', input: { id: 'u1' } });

    // Each replays only what it owns — the reason a second app cannot drop the first's unsent work.
    expect((await billing.mine()).map((entry) => entry.mutationId)).toEqual(['invoice.pay']);
    expect((await profile.mine()).map((entry) => entry.mutationId)).toEqual(['profile.rename']);

    // But "are there unsent changes?" is a page-wide question, and both can answer it honestly.
    expect(await billing.all()).toHaveLength(2);
    expect((await billing.foreign()).map((entry) => entry.mutationId)).toEqual(['profile.rename']);
  });
});

describe('what happens when two fragments race', () => {
  it('lets the later write win, without tearing either record', async () => {
    const driver = memoryRecordDriver();
    const partition = () => partitionKey('user:ana');
    const checkout = createDataClient({
      driver,
      partition,
      collection: 'entities',
      outbox: createOutbox({ driver, owner: 'checkout', collection: 'outbox' }),
    });
    const account = createDataClient({
      driver,
      partition,
      collection: 'entities',
      outbox: createOutbox({ driver, owner: 'account', collection: 'outbox' }),
    });

    const write = (client: ReturnType<typeof createDataClient>, name: string) =>
      client.mutate<Customer>({
        key: 'customer:c1',
        schema: CustomerContract,
        mutationId: 'customer.rename',
        input: { id: 'c1', name },
        patch: { name },
        // Each fragment stores what the server handed *it* back.
        send: async (input) => input,
      });

    await write(checkout, 'Ana from checkout');
    await write(account, 'Ana from the account panel');

    const reader = account.query<Customer>({
      key: 'customer:c1',
      schema: CustomerContract,
      fetch: async () => ({ id: 'c1', name: 'from the network' }),
      staleWhileRevalidate: false,
    });
    const state = await settled(reader, (s) => s.data !== undefined);

    // Last write wins, wholesale — there is no compare-and-set in the store, and no field-level
    // merge. What there *is*: a whole record from one writer, never halves of two.
    expect(state.data).toEqual({ id: 'c1', name: 'Ana from the account panel' });

    reader.dispose();
    checkout.close();
    account.close();
  });

  it('keeps both entries when two fragments queue at the same moment', async () => {
    const driver = memoryRecordDriver();
    const checkout = createOutbox({ driver, owner: 'checkout', collection: 'outbox' });
    const account = createOutbox({ driver, owner: 'account', collection: 'outbox' });

    // Appended concurrently. One record per entry means enqueue never reads the queue first, so
    // there is no read-modify-write for two writers to lose each other in — the failure the queue
    // had when it lived under a single key.
    await Promise.all([
      checkout.enqueue({ mutationId: 'invoice.pay', input: { id: 'i1' } }),
      account.enqueue({ mutationId: 'profile.rename', input: { id: 'u1' } }),
      checkout.enqueue({ mutationId: 'invoice.pay', input: { id: 'i2' } }),
    ]);

    expect(await checkout.all()).toHaveLength(3);
    expect(await checkout.mine()).toHaveLength(2);
    expect(await account.mine()).toHaveLength(1);
  });
});

