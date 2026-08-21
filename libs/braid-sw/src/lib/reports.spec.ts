import { memoryRecordDriver } from '@braid/data';
import { describe, expect, it, vi } from 'vitest';
import { createReportQueue, type BraidReport } from './reports.js';

/**
 * The queue exists because the reports most worth having are the ones most likely to be lost: a
 * user who hits a broken deploy is a user who closes the tab, and a `fetch` started during teardown
 * usually loses that race.
 */

const report = (url: string): BraidReport => ({
  kind: 'asset',
  at: '2026-01-01T00:00:00.000Z',
  report: { fragmentId: 'billing', url, outcome: 'cache-after-404', partition: 'braid-frag:billing' },
});

function setup(fetchImpl: typeof fetch) {
  return createReportQueue({
    endpoint: 'https://shop.example/__telemetry',
    driver: memoryRecordDriver(),
    fetch: fetchImpl,
  });
}

describe('recording', () => {
  it('sends what is queued as one batch', async () => {
    const sent: unknown[] = [];
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    const queue = setup(fetchImpl);

    await queue.record(report('/a.js'));
    await queue.record(report('/b.js'));
    const outcome = await queue.flush();

    // One request, not two: a worker waking to flush forty reports should not make forty requests.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({ sent: 2, remaining: 0 });
    expect((sent[0] as { reports: unknown[] }).reports).toHaveLength(2);
  });

  it('sends no request when nothing is queued', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;

    expect(await setup(fetchImpl).flush()).toEqual({ sent: 0, remaining: 0 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('omits credentials', async () => {
    let init: RequestInit | undefined;
    const queue = setup((async (_url: unknown, given?: RequestInit) => {
      init = given;
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch);

    await queue.record(report('/a.js'));
    await queue.flush();

    // Diagnostics, not a session. Sending credentials would attach identity to data nobody asked to
    // have attached to them.
    expect(init?.credentials).toBe('omit');
  });
});

describe('surviving a refusal', () => {
  it('keeps everything queued when the endpoint is unreachable', async () => {
    const queue = setup((async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch);

    await queue.record(report('/a.js'));
    const outcome = await queue.flush();

    // Being offline is the case the queue exists for, so it must not be the case that empties it.
    expect(outcome).toEqual({ sent: 0, remaining: 1 });
    expect(await queue.pending()).toBe(1);
  });

  it('keeps the batch when the endpoint rejects it', async () => {
    const queue = setup((async () => new Response('nope', { status: 503 })) as unknown as typeof fetch);

    await queue.record(report('/a.js'));

    expect(await queue.flush()).toEqual({ sent: 0, remaining: 1 });
  });

  it('sends the backlog once the endpoint comes back', async () => {
    let down = true;
    const queue = setup((async () => {
      if (down) throw new TypeError('Failed to fetch');
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch);

    await queue.record(report('/a.js'));
    await queue.flush();
    await queue.record(report('/b.js'));
    down = false;

    expect(await queue.flush()).toEqual({ sent: 2, remaining: 0 });
    expect(await queue.pending()).toBe(0);
  });

  it('bounds a flush to its batch size', async () => {
    const queue = createReportQueue({
      endpoint: 'https://shop.example/__telemetry',
      driver: memoryRecordDriver(),
      batchSize: 2,
      fetch: (async () => new Response(null, { status: 204 })) as unknown as typeof fetch,
    });

    for (const url of ['/a.js', '/b.js', '/c.js']) await queue.record(report(url));

    // One flush must not become an unbounded upload; the rest wait for the next one.
    expect(await queue.flush()).toEqual({ sent: 2, remaining: 1 });
    expect(await queue.flush()).toEqual({ sent: 1, remaining: 0 });
  });
});
