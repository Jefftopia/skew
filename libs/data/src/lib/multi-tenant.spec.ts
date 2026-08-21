import { versioned } from '@braidlabs/skew';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInvalidator, resetSharedInvalidators } from './invalidation.js';
import { memoryRecordDriver } from './memory-driver.js';
import { createOutbox } from './outbox.js';
import { createDataClient, type Query, type QueryState } from './query.js';
import { createRecordStore } from './record-store.js';
import { partitionKey } from './tenancy.js';
import type { PushSink } from './adapters.js';

/**
 * Two tabs of one shell, each looking at a different client.
 *
 * This is the wealth-advisory shape, and it is the one where "same app, same entity ids, different
 * tenant" stops being an abstraction: `holding:h1` exists for every client, every tab fetches it, and
 * a leak between them is one client's position on another client's screen.
 */

interface Holding {
  id: string;
  shares: number;
}

const HoldingContract = versioned<Holding>('advisory.holding');

/** The advisor, acting as one of their clients. Two tabs, two partitions, one origin. */
const forClient = (client: string) => partitionKey('advisor:ana', client);

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

function tab(driver: ReturnType<typeof memoryRecordDriver>, client: string) {
  const partition = forClient(client);
  return createDataClient({
    driver,
    partition: () => partition,
    collection: 'entities',
    // Session-scoped by design: a queued write belongs to the session, not to whichever client was
    // on screen when it was made. Both tabs therefore share one queue.
    outbox: createOutbox({ driver, owner: 'advisor', collection: 'outbox' }),
    autoFlush: false,
    invalidator: createInvalidator({ partition }),
  });
}

afterEach(() => resetSharedInvalidators());

describe('two clients, one advisor, two tabs', () => {
  it('does not show one client\'s unsent trade on another client\'s screen', async () => {
    const driver = memoryRecordDriver();
    const smith = tab(driver, 'client:smith');
    const jones = tab(driver, 'client:jones');

    // Offline, so the trade stays queued with its overlay applied.
    await smith.mutate<Holding>({
      key: 'holding:h1',
      schema: HoldingContract,
      mutationId: 'holding.trade',
      input: { id: 'h1', shares: 999 },
      patch: { shares: 999 },
      send: async () => {
        throw new TypeError('Failed to fetch');
      },
    });

    const smithView = smith.query<Holding>({
      key: 'holding:h1',
      schema: HoldingContract,
      fetch: async () => ({ id: 'h1', shares: 10 }),
      staleWhileRevalidate: false,
    });
    const jonesView = jones.query<Holding>({
      key: 'holding:h1',
      schema: HoldingContract,
      fetch: async () => ({ id: 'h1', shares: 20 }),
      staleWhileRevalidate: false,
    });

    const seenBySmith = await settled(smithView, (state) => state.data !== undefined);
    const seenByJones = await settled(jonesView, (state) => state.data !== undefined);

    // The advisor who made the trade still sees it pending…
    expect(seenBySmith.data?.shares).toBe(999);
    expect(seenBySmith.pending).toBe(true);

    // …and the other client's tab shows that client's own position, with nothing pending.
    expect(seenByJones.data?.shares).toBe(20);
    expect(seenByJones.pending).toBe(false);

    smithView.dispose();
    jonesView.dispose();
    smith.close();
    jones.close();
  });

  it('still flushes the queued trade whichever client is on screen', async () => {
    const driver = memoryRecordDriver();
    const smith = tab(driver, 'client:smith');
    const jones = tab(driver, 'client:jones');

    let online = false;
    const send = async (input: unknown) => {
      if (!online) throw new TypeError('Failed to fetch');
      return input;
    };

    await smith.mutate<Holding>({
      key: 'holding:h1',
      schema: HoldingContract,
      mutationId: 'holding.trade',
      input: { id: 'h1', shares: 999 },
      patch: { shares: 999 },
      send,
    });

    online = true;
    jones.registerMutation('holding.trade', send);

    // The queue is the *session's*, so the other tab drains it. Only the overlay was tenant-scoped —
    // scoping the queue too would strand a trade behind whichever client the advisor closed.
    expect((await jones.flush()).sent).toBe(1);

    smith.close();
    jones.close();
  });

  it('keeps invalidation inside the client it belongs to', async () => {
    const driver = memoryRecordDriver();
    const smith = tab(driver, 'client:smith');
    const jones = tab(driver, 'client:jones');

    const jonesFetches = vi.fn(async () => ({ id: 'h1', shares: 20 }));
    const jonesView = jones.query<Holding>({
      key: 'holding:h1',
      tags: ['holding#h1'],
      schema: HoldingContract,
      fetch: jonesFetches,
      staleWhileRevalidate: false,
    });
    await settled(jonesView, (state) => state.data !== undefined);
    const before = jonesFetches.mock.calls.length;

    smith.invalidate('holding#h1');
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Same tag, different tenant: the other client's view has not gone stale.
    expect(jonesFetches.mock.calls.length).toBe(before);

    jonesView.dispose();
    smith.close();
    jones.close();
  });

  it('gives each client its own cached record under the same key', async () => {
    const driver = memoryRecordDriver();
    const smith = tab(driver, 'client:smith');
    const jones = tab(driver, 'client:jones');

    const smithView = smith.query<Holding>({
      key: 'holding:h1',
      schema: HoldingContract,
      fetch: async () => ({ id: 'h1', shares: 10 }),
      staleWhileRevalidate: false,
    });
    const jonesView = jones.query<Holding>({
      key: 'holding:h1',
      schema: HoldingContract,
      fetch: async () => ({ id: 'h1', shares: 20 }),
      staleWhileRevalidate: false,
    });

    expect((await settled(smithView, (s) => s.data !== undefined)).data?.shares).toBe(10);
    expect((await settled(jonesView, (s) => s.data !== undefined)).data?.shares).toBe(20);
    // Both went to the network: a shared cache is shared *within* a tenant, never across one.
    expect((await settled(jonesView, (s) => s.data !== undefined)).fromCache).toBe(false);

    smithView.dispose();
    jonesView.dispose();
    smith.close();
    jones.close();
  });
});

describe('one stream, several funds', () => {
  it('files each pushed record under the fund it belongs to', async () => {
    const driver = memoryRecordDriver();
    const alpha = forClient('fund:alpha');
    const beta = forClient('fund:beta');

    // A desk subscribed to every fund it covers, running in the tab that is showing alpha.
    const client = createDataClient({
      driver,
      partition: () => alpha,
      collection: 'entities',
      invalidator: createInvalidator({ partition: alpha }),
    });

    let sink!: PushSink;
    const disconnect = client.connect({ schema: HoldingContract, source: (given) => void (sink = given) });

    await sink.receive({ key: 'holding:h1', value: { id: 'h1', shares: 1 } });
    await sink.receive({ key: 'holding:h1', value: { id: 'h1', shares: 2 }, partition: beta });

    const store = createRecordStore<Holding>({ driver, collection: 'entities', schema: HoldingContract });
    expect((await store.get('holding:h1', alpha))?.value.shares).toBe(1);
    // Without naming the partition, beta's event would have landed in alpha's cache — one fund's
    // position filed under another because of which tab happened to hold the socket.
    expect((await store.get('holding:h1', beta))?.value.shares).toBe(2);

    disconnect();
    client.close();
  });

  it('sends an event that concerns both funds to both', async () => {
    const driver = memoryRecordDriver();
    const alpha = forClient('fund:alpha');
    const beta = forClient('fund:beta');
    const client = createDataClient({
      driver,
      partition: () => alpha,
      collection: 'entities',
      invalidator: createInvalidator({ partition: alpha }),
    });

    let sink!: PushSink;
    const disconnect = client.connect({ schema: HoldingContract, source: (given) => void (sink = given) });

    // A corporate action touching a holding both funds carry: the stream addresses it twice, because
    // "both" is a fact about the event that only the publisher knows.
    for (const partition of [alpha, beta]) {
      await sink.receive({ key: 'holding:shared', value: { id: 'shared', shares: 50 }, partition });
    }

    const store = createRecordStore<Holding>({ driver, collection: 'entities', schema: HoldingContract });
    expect((await store.get('holding:shared', alpha))?.value.shares).toBe(50);
    expect((await store.get('holding:shared', beta))?.value.shares).toBe(50);

    disconnect();
    client.close();
  });
});
