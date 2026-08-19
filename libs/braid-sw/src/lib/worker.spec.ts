import { describe, expect, it, vi } from 'vitest';
import { diagnoseSkew } from './skew-report.js';
import { setupBraidWorker } from './worker.js';

/**
 * The worker's own version boundary, and the wiring around it.
 *
 * A worker that fails silently is worse than no worker: it serves yesterday's assets to today's
 * document, and the resulting failure looks like an application bug in an application that is fine.
 */

describe('diagnoseSkew', () => {
  it('says nothing is wrong when the two agree', () => {
    expect(diagnoseSkew({ buildId: 'b-7' }, { buildId: 'b-7' }).severity).toBe('ok');
  });

  it('is silent when either side declines to say what it is', () => {
    // Half a comparison is not a disagreement, and reporting one would train people to ignore it.
    expect(diagnoseSkew({ buildId: 'b-7' }, {}).severity).toBe('ok');
    expect(diagnoseSkew({}, { buildId: 'b-8' }).severity).toBe('ok');
  });

  it('names a build disagreement without guessing which side is stale', () => {
    const diagnosis = diagnoseSkew({ buildId: 'b-7' }, { buildId: 'b-8' });

    expect(diagnosis.severity).toBe('worker-behind');
    expect(diagnosis.message).toContain('b-7');
    expect(diagnosis.message).toContain('b-8');
    expect(diagnosis.fixHint).toBeTruthy();
  });

  it('reports a snapshot disagreement ahead of a build one', () => {
    // Fragments disagreeing about which fragments *exist* is the more consequential of the two.
    const diagnosis = diagnoseSkew(
      { buildId: 'b-7', snapshotId: 's-1' },
      { buildId: 'b-8', snapshotId: 's-2' },
    );

    expect(diagnosis.severity).toBe('snapshot-mismatch');
  });
});

describe('setupBraidWorker', () => {
  /** A worker scope good enough to drive the handlers without a browser. */
  function scope() {
    const listeners = new Map<string, (event: never) => void>();
    const original = {
      addEventListener: (globalThis as Record<string, unknown>)['addEventListener'],
      clients: (globalThis as Record<string, unknown>)['clients'],
    };

    (globalThis as Record<string, unknown>)['addEventListener'] = (type: string, listener: (event: never) => void) =>
      void listeners.set(type, listener);

    return {
      listeners,
      dispatch: (type: string, event: unknown) => listeners.get(type)?.(event as never),
      restore: () => {
        (globalThis as Record<string, unknown>)['addEventListener'] = original.addEventListener;
        (globalThis as Record<string, unknown>)['clients'] = original.clients;
      },
    };
  }

  it('answers a page that introduces itself, and warns on disagreement', () => {
    const worker = scope();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    setupBraidWorker({ buildId: 'b-7', fetch: vi.fn() });

    const replies: unknown[] = [];
    worker.dispatch('message', {
      data: { type: 'braid-sw:hello', page: { buildId: 'b-8' } },
      source: { postMessage: (message: unknown) => replies.push(message) },
    });

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('b-7'));
    expect(replies).toHaveLength(1);
    expect((replies[0] as { diagnosis: { severity: string } }).diagnosis.severity).toBe('worker-behind');

    warn.mockRestore();
    worker.restore();
  });

  it('ignores messages that are not its own', () => {
    const worker = scope();
    setupBraidWorker({ buildId: 'b-7', fetch: vi.fn() });
    const replies: unknown[] = [];

    worker.dispatch('message', {
      data: { type: 'some-other-app:ping' },
      source: { postMessage: (message: unknown) => replies.push(message) },
    });

    expect(replies).toEqual([]);
    worker.restore();
  });

  it('responds to namespace requests and leaves everything else to the page', () => {
    const worker = scope();
    setupBraidWorker({ fetch: vi.fn(async () => new Response('js')), caches: undefined });

    const responded: unknown[] = [];
    const event = (url: string) => ({
      request: new Request(url),
      respondWith: (response: unknown) => responded.push(response),
    });

    worker.dispatch('fetch', event('https://shop.example/__braid/frag/billing/main.js'));
    expect(responded).toHaveLength(1);

    worker.dispatch('fetch', event('https://shop.example/index.html'));
    // Still one: the shell's own routes are the shell's business.
    expect(responded).toHaveLength(1);

    worker.restore();
  });

  it('does not claim open pages unless asked', async () => {
    const worker = scope();
    const claim = vi.fn(async () => undefined);
    (globalThis as Record<string, unknown>)['clients'] = { claim };

    setupBraidWorker({ fetch: vi.fn() });
    const waited: Promise<unknown>[] = [];
    worker.dispatch('activate', { waitUntil: (promise: Promise<unknown>) => waited.push(promise) });
    await Promise.all(waited);

    // Claiming swaps the worker underneath a page mid-session, so it is opt-in: waiting for the
    // next navigation is the boring, correct default.
    expect(claim).not.toHaveBeenCalled();

    worker.restore();
  });
});
