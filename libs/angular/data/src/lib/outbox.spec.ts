import { TestBed } from '@angular/core/testing';
import { createVersionedStore, memoryDriver } from '@skew/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DATA_OPTIONS, resolveDataOptions } from './config';
import { OutboxService } from './outbox';

/**
 * The outbox is the only component here that must survive a reload, so the
 * tests lean on a shared driver map to simulate one: a fresh TestBed with the
 * same underlying storage is exactly what a page refresh looks like.
 */

function configure(options: {
  storage?: Map<string, string>;
  maxAttempts?: number;
  onError?: (message: string, detail?: unknown) => void;
  persist?: boolean;
}) {
  const storage = options.storage ?? new Map<string, string>();
  const driver = memoryDriver(storage);

  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      {
        provide: DATA_OPTIONS,
        useValue: resolveDataOptions({
          maxOutboxAttempts: options.maxAttempts ?? 5,
          ...(options.onError ? { onOutboxError: options.onError } : {}),
          ...(options.persist === false
            ? {}
            : { outboxStore: (schema) => createVersionedStore(schema, { driver }) }),
        }),
      },
    ],
  });

  return { outbox: TestBed.inject(OutboxService), storage };
}

beforeEach(() => TestBed.resetTestingModule());

describe('OutboxService', () => {
  it('queues work and reports it as pending', async () => {
    const { outbox } = configure({});

    await outbox.enqueue({ mutationId: 'publish', input: { id: '1' }, schemaVersion: 1 });

    expect(outbox.pendingCount()).toBe(1);
    expect(outbox.hasPendingWork()).toBe(true);
  });

  it('flushes a queued entry through its registered runner', async () => {
    const { outbox } = configure({});
    const runner = vi.fn(async () => undefined);
    outbox.register('publish', runner);

    await outbox.enqueue({ mutationId: 'publish', input: { id: '1' }, schemaVersion: 1 });
    const result = await outbox.flush();

    expect(runner).toHaveBeenCalledWith({ id: '1' }, expect.objectContaining({ attempts: 0 }));
    expect(result).toEqual({ sent: 1, failed: 0, remaining: 0 });
    expect(outbox.pendingCount()).toBe(0);
  });

  it('survives a reload', async () => {
    const storage = new Map<string, string>();

    // Session one: queue work, then the tab goes away.
    const first = configure({ storage });
    await first.outbox.enqueue({ mutationId: 'publish', input: { id: '7' }, schemaVersion: 3 });
    expect(storage.size).toBeGreaterThan(0);

    // Session two: same storage, fresh everything else.
    const second = configure({ storage });
    const runner = vi.fn(async () => undefined);
    second.outbox.register('publish', runner);
    await second.outbox.flush();

    expect(runner).toHaveBeenCalledWith({ id: '7' }, expect.objectContaining({ schemaVersion: 3 }));
  });

  it('flushes strictly in order', async () => {
    const { outbox } = configure({});
    const order: string[] = [];
    outbox.register('op', async (input) => {
      order.push((input as { id: string }).id);
    });

    await outbox.enqueue({ mutationId: 'op', input: { id: 'a' }, schemaVersion: 1 });
    await outbox.enqueue({ mutationId: 'op', input: { id: 'b' }, schemaVersion: 1 });
    await outbox.enqueue({ mutationId: 'op', input: { id: 'c' }, schemaVersion: 1 });
    await outbox.flush();

    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('stops the drain on failure rather than skipping ahead', async () => {
    // Entries commonly depend on each other; running later ones after an
    // earlier failure can apply them out of order.
    const { outbox } = configure({});
    const seen: string[] = [];
    outbox.register('op', async (input) => {
      const id = (input as { id: string }).id;
      seen.push(id);
      if (id === 'a') throw new Error('network');
    });

    await outbox.enqueue({ mutationId: 'op', input: { id: 'a' }, schemaVersion: 1 });
    await outbox.enqueue({ mutationId: 'op', input: { id: 'b' }, schemaVersion: 1 });
    await outbox.flush();

    expect(seen).toEqual(['a']);
    expect(outbox.pendingCount()).toBe(2);
  });

  it('retries and records the attempt count', async () => {
    const { outbox } = configure({ maxAttempts: 5 });
    outbox.register('op', async () => {
      throw new Error('still down');
    });
    await outbox.enqueue({ mutationId: 'op', input: {}, schemaVersion: 1 });

    await outbox.flush();
    await outbox.flush();

    expect(outbox.entries()[0]?.attempts).toBe(2);
    expect(outbox.entries()[0]?.lastError).toBe('still down');
  });

  it('abandons an entry once attempts are exhausted, loudly', async () => {
    const onError = vi.fn();
    const { outbox } = configure({ maxAttempts: 2, onError });
    outbox.register('op', async () => {
      throw new Error('permanent');
    });
    await outbox.enqueue({ mutationId: 'op', input: {}, schemaVersion: 1 });

    await outbox.flush();
    await outbox.flush();

    expect(outbox.pendingCount()).toBe(0);
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('giving up'), expect.anything());
  });

  it('drops an entry whose mutation no longer exists in this build', async () => {
    const onError = vi.fn();
    const { outbox } = configure({ onError });
    await outbox.enqueue({ mutationId: 'renamed.away', input: {}, schemaVersion: 1 });

    const result = await outbox.flush();

    expect(result.failed).toBe(1);
    expect(outbox.pendingCount()).toBe(0);
    expect(onError).toHaveBeenCalledWith(
      expect.stringContaining('no registered mutation'),
      expect.anything(),
    );
  });

  it('leaves a queue written by a newer build untouched', async () => {
    const storage = new Map<string, string>();
    // A future build wrote this; migrating it downward would send payloads
    // this build does not understand.
    storage.set(
      'skew-outbox:queue',
      JSON.stringify({ v: 99, payload: { entries: [{ id: 'x' }] } }),
    );
    const onError = vi.fn();
    const { outbox } = configure({ storage, onError });

    await outbox.load();

    expect(outbox.pendingCount()).toBe(0);
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('newer build'), expect.anything());
  });

  it('does not run two flushes concurrently', async () => {
    const { outbox } = configure({});
    let active = 0;
    let maxActive = 0;
    outbox.register('op', async () => {
      maxActive = Math.max(maxActive, ++active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
    });
    await outbox.enqueue({ mutationId: 'op', input: {}, schemaVersion: 1 });

    await Promise.all([outbox.flush(), outbox.flush()]);

    expect(maxActive).toBe(1);
  });

  it('clears the queue on demand', async () => {
    const { outbox } = configure({});
    await outbox.enqueue({ mutationId: 'op', input: {}, schemaVersion: 1 });

    await outbox.clear();

    expect(outbox.pendingCount()).toBe(0);
  });

  it('works without persistence, keeping the queue in memory', async () => {
    const { outbox } = configure({ persist: false });
    const runner = vi.fn(async () => undefined);
    outbox.register('op', runner);

    await outbox.enqueue({ mutationId: 'op', input: {}, schemaVersion: 1 });
    await outbox.flush();

    expect(runner).toHaveBeenCalledOnce();
  });
});
