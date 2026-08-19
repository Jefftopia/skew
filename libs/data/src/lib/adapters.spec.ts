import { versioned } from '@skewkit/core';
import { describe, expect, it, vi } from 'vitest';
import { fromPull, type PushAdapter, type PushSink } from './adapters.js';
import { memoryRecordDriver } from './memory-driver.js';
import { createDataClient, type Query, type QueryState } from './query.js';
import { createInvalidator } from './invalidation.js';

/**
 * The adapters exist so the layer never learns a protocol. Push is the shape with behaviour worth
 * testing: it is a third write source, and these are about it landing through the same path as the
 * other two rather than beside them.
 */

interface Quote {
  symbol: string;
  price: number;
}

const QuoteSchema = versioned<Quote>('adapter-spec-quote');

/**
 * The record store composes its storage key from the partition and the caller's key, separated
 * by a NUL — written as an escape here because a literal control character in a source file is
 * invisible to whoever reads this next.
 */
const storageKey = (key: string) => `test\u0000${key}`;

function setup() {
  const driver = memoryRecordDriver();
  const client = createDataClient({
    driver,
    partition: () => 'test',
    collection: 'entities',
    invalidator: createInvalidator({ partition: 'test' }),
  });
  return { client, driver };
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

describe('fromPull', () => {
  it('hands the key and the abort signal to the transport', async () => {
    const adapter = vi.fn(async (key: string) => ({ symbol: key, price: 1 }));
    const controller = new AbortController();

    await fromPull('quote:IBM', adapter)(controller.signal);

    expect(adapter).toHaveBeenCalledWith('quote:IBM', controller.signal);
  });
});

describe('push', () => {
  it('lands a pushed record in the store and refreshes readers without a fetch', async () => {
    const { client } = setup();
    const fetches = vi.fn(async () => ({ symbol: 'IBM', price: 100 }));

    const query = client.query<Quote>({
      key: 'quote:IBM',
      schema: QuoteSchema,
      fetch: fetches,
      staleWhileRevalidate: false,
    });
    await settled(query, (state) => state.data !== undefined);
    expect(fetches).toHaveBeenCalledTimes(1);

    let sink!: PushSink;
    const source: PushAdapter = (given) => void (sink = given);
    const disconnect = client.connect({ schema: QuoteSchema, source });

    await sink.receive({ key: 'quote:IBM', value: { symbol: 'IBM', price: 142 } });
    const state = await settled(query, (s) => s.data?.price === 142);

    expect(state.data).toEqual({ symbol: 'IBM', price: 142 });
    // The push *is* the newest thing anyone has. Going back to the network for it would answer a
    // delivery by asking for the thing that was just delivered.
    expect(fetches).toHaveBeenCalledTimes(1);

    disconnect();
    query.dispose();
    client.close();
  });

  it('envelopes what it writes, so an older reader can still read it', async () => {
    const { client, driver } = setup();
    let sink!: PushSink;
    const disconnect = client.connect({
      schema: QuoteSchema,
      source: (given) => void (sink = given),
    });

    await sink.receive({ key: 'quote:IBM', value: { symbol: 'IBM', price: 7 } });

    // A pushed record must not be the one write in the system with no version on it — that is
    // precisely the record a fragment two majors behind will read.
    const stored = await driver.get('entities', storageKey('quote:IBM'));
    expect(stored?.envelope.v).toBe(QuoteSchema.version);
    expect(stored?.envelope.payload).toEqual({ symbol: 'IBM', price: 7 });

    disconnect();
    client.close();
  });

  it('stops writing once disconnected', async () => {
    const { client, driver } = setup();
    let sink!: PushSink;
    const disconnect = client.connect({
      schema: QuoteSchema,
      source: (given) => void (sink = given),
    });

    disconnect();
    await sink.receive({ key: 'quote:IBM', value: { symbol: 'IBM', price: 9 } });

    expect(await driver.get('entities', storageKey('quote:IBM'))).toBeNull();
    client.close();
  });

  it('runs the disposer the transport returned', async () => {
    const { client } = setup();
    const dispose = vi.fn();
    const disconnect = client.connect({ schema: QuoteSchema, source: () => dispose });

    disconnect();
    await Promise.resolve();

    expect(dispose).toHaveBeenCalledOnce();
    client.close();
  });

  it('marks the tags a list query declared', async () => {
    const { client } = setup();
    const fetches = vi.fn(async () => ({ symbol: 'ALL', price: 0 }));
    const list = client.query<Quote>({
      key: 'quotes:all',
      tags: ['quotes'],
      schema: QuoteSchema,
      fetch: fetches,
    });
    await settled(list, (state) => state.data !== undefined);
    const before = fetches.mock.calls.length;

    let sink!: PushSink;
    const disconnect = client.connect({
      schema: QuoteSchema,
      source: (given) => void (sink = given),
      tags: () => ['quotes'],
    });
    await sink.receive({ key: 'quote:IBM', value: { symbol: 'IBM', price: 3 } });
    await new Promise((resolve) => setTimeout(resolve, 10));

    // A list cannot be refreshed from one record, so this one does go back to the network.
    expect(fetches.mock.calls.length).toBeGreaterThan(before);

    disconnect();
    list.dispose();
    client.close();
  });
});
