import { describe, expect, it, vi } from 'vitest';
import { createBreaker, type BreakerTransition } from './breaker.js';
import { createGateway } from './gateway.js';
import { cspNonceOf, withNonce } from './rewriter/transforms.js';
import type { TelemetryEvent } from './telemetry.js';

/** A controllable clock, so cooldowns are asserted rather than waited for. */
function clock(start = 0) {
  let now = start;
  return { now: () => now, advance: (ms: number) => void (now += ms) };
}

describe('createBreaker', () => {
  it('stays closed below the failure threshold', () => {
    const breaker = createBreaker({ failureThreshold: 3 });

    breaker.failed('billing');
    breaker.failed('billing');

    expect(breaker.allows('billing')).toBe(true);
    expect(breaker.stateOf('billing')).toBe('closed');
  });

  it('opens on consecutive failures and sheds while open', () => {
    const time = clock();
    const breaker = createBreaker({ failureThreshold: 3, resetTimeoutMs: 1000 }, undefined, time.now);

    breaker.failed('billing');
    breaker.failed('billing');
    breaker.failed('billing');

    expect(breaker.stateOf('billing')).toBe('open');
    expect(breaker.allows('billing')).toBe(false);
  });

  // The counter measures a *run* of failures, not a lifetime total: an endpoint that fails
  // occasionally and recovers is healthy, and treating it otherwise would open on any busy day.
  it('resets the run on success', () => {
    const breaker = createBreaker({ failureThreshold: 3 });

    breaker.failed('billing');
    breaker.failed('billing');
    breaker.succeeded('billing');
    breaker.failed('billing');
    breaker.failed('billing');

    expect(breaker.stateOf('billing')).toBe('closed');
  });

  it('admits exactly one probe once the cooldown elapses', () => {
    const time = clock();
    const breaker = createBreaker({ failureThreshold: 1, resetTimeoutMs: 1000 }, undefined, time.now);

    breaker.failed('billing');
    expect(breaker.allows('billing')).toBe(false);

    time.advance(1000);
    expect(breaker.allows('billing')).toBe(true);
    // A recovering endpoint hit with the load that took it down goes down again, so the rest
    // is still shed until the probe reports back.
    expect(breaker.allows('billing')).toBe(false);
  });

  it('closes when the probe succeeds', () => {
    const time = clock();
    const breaker = createBreaker({ failureThreshold: 1, resetTimeoutMs: 1000 }, undefined, time.now);

    breaker.failed('billing');
    time.advance(1000);
    breaker.allows('billing');
    breaker.succeeded('billing');

    expect(breaker.stateOf('billing')).toBe('closed');
    expect(breaker.allows('billing')).toBe(true);
  });

  it('re-opens and restarts the cooldown when the probe fails', () => {
    const time = clock();
    const breaker = createBreaker({ failureThreshold: 3, resetTimeoutMs: 1000 }, undefined, time.now);

    breaker.failed('billing');
    breaker.failed('billing');
    breaker.failed('billing');
    time.advance(1000);
    breaker.allows('billing');
    breaker.failed('billing');

    expect(breaker.stateOf('billing')).toBe('open');
    expect(breaker.allows('billing')).toBe(false);
  });

  // Fragments are independently deployed; one team's bad release must not shed another's traffic.
  it('isolates circuits per fragment', () => {
    const breaker = createBreaker({ failureThreshold: 1 });

    breaker.failed('billing');

    expect(breaker.allows('billing')).toBe(false);
    expect(breaker.allows('reviews')).toBe(true);
  });

  it('reports transitions on the edges only, never per request', () => {
    const time = clock();
    const transitions: BreakerTransition[] = [];
    const breaker = createBreaker({ failureThreshold: 2, resetTimeoutMs: 500 }, (t) => transitions.push(t), time.now);

    breaker.failed('billing');
    breaker.failed('billing');
    breaker.allows('billing');
    breaker.allows('billing');
    time.advance(500);
    breaker.allows('billing');
    breaker.succeeded('billing');

    expect(transitions.map((t) => `${t.from}→${t.to}`)).toEqual(['closed→open', 'open→half-open', 'half-open→closed']);
  });
});

describe('gateway breaker', () => {
  const registry = [{ id: 'billing', endpoint: 'https://billing.test', pierce: ['/billing/*'] }];
  const shell = () =>
    new Response('<!doctype html><html><head></head><body><fragment-slot name="billing"></fragment-slot></body></html>', {
      headers: { 'content-type': 'text/html' },
    });

  it('stops calling a failing endpoint and reports the request as shed', async () => {
    const events: TelemetryEvent[] = [];
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('down'));

    const gateway = createGateway({
      registry,
      breaker: { failureThreshold: 2, resetTimeoutMs: 60_000 },
      telemetry: { on: (event) => events.push(event) },
    });

    const request = () =>
      gateway.handle(new Request('https://shell.test/billing/x', { headers: { 'sec-fetch-dest': 'document' } }), async () =>
        shell(),
      );

    await request();
    await request();
    const callsAfterOpening = fetchMock.mock.calls.length;
    await request();
    await request();

    // The endpoint is contacted twice, then never again — that is the whole point.
    expect(fetchMock.mock.calls.length).toBe(callsAfterOpening);
    fetchMock.mockRestore();

    const outcomes = events.filter((e) => e.kind === 'fragment-fetch').map((e) => (e as { outcome: string }).outcome);
    expect(outcomes).toEqual(['error', 'error', 'shed', 'shed']);
    expect(events.some((e) => e.kind === 'breaker' && e.to === 'open')).toBe(true);
  });

  it('leaves the endpoint alone when no breaker is configured', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('down'));
    const gateway = createGateway({ registry });

    for (let i = 0; i < 4; i++) {
      await gateway.handle(
        new Request('https://shell.test/billing/x', { headers: { 'sec-fetch-dest': 'document' } }),
        async () => shell(),
      );
    }

    expect(fetchMock.mock.calls.length).toBe(4);
    fetchMock.mockRestore();
  });
});

describe('cspNonceOf', () => {
  const headers = (policy: string) => new Headers({ 'content-security-policy': policy });

  it('reads a nonce from script-src', () => {
    expect(cspNonceOf(headers("default-src 'self'; script-src 'nonce-abc123'"))).toBe('abc123');
  });

  it('reads a nonce from style-src and from default-src', () => {
    expect(cspNonceOf(headers("style-src 'nonce-styleNonce='"))).toBe('styleNonce=');
    expect(cspNonceOf(headers("default-src 'nonce-fallback1'"))).toBe('fallback1');
  });

  // Minting one would be worse than useless: a nonce the shell's policy does not list is not
  // trusted, so the right answer is to stamp nothing.
  it('returns null when there is no policy or no nonce in it', () => {
    expect(cspNonceOf(new Headers())).toBeNull();
    expect(cspNonceOf(headers("script-src 'self' 'unsafe-inline'"))).toBeNull();
  });
});

describe('withNonce', () => {
  it('stamps script and style tags', () => {
    expect(withNonce('<style>a{}</style><script src="/x.js" defer></script>', 'n1')).toBe(
      '<style nonce="n1">a{}</style><script nonce="n1" src="/x.js" defer></script>',
    );
  });

  it('is a no-op without a nonce', () => {
    expect(withNonce('<style>a{}</style>', null)).toBe('<style>a{}</style>');
  });
});

describe('gateway CSP', () => {
  const registry = [{ id: 'billing', endpoint: 'https://billing.test', pierce: ['/billing/*'] }];

  it('stamps the shell nonce onto everything it injects', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('<p>ok</p>', { headers: { 'content-type': 'text/html' } }),
    );

    const gateway = createGateway({ registry, telemetry: { on: () => undefined, webVitals: true } });
    const page = await gateway.handle(
      new Request('https://shell.test/billing/x', { headers: { 'sec-fetch-dest': 'document' } }),
      async () =>
        new Response('<!doctype html><html><head></head><body><fragment-slot name="billing"></fragment-slot></body></html>', {
          headers: { 'content-type': 'text/html', 'content-security-policy': "script-src 'nonce-r4nd0m'" },
        }),
    );

    const body = await page!.text();
    fetchMock.mockRestore();

    expect(body).toContain('<style nonce="r4nd0m">');
    expect(body).toContain('<script nonce="r4nd0m"');
  });

  it('injects unstamped markup when the shell sends no policy', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('<p>ok</p>', { headers: { 'content-type': 'text/html' } }),
    );

    const gateway = createGateway({ registry });
    const page = await gateway.handle(
      new Request('https://shell.test/billing/x', { headers: { 'sec-fetch-dest': 'document' } }),
      async () =>
        new Response('<!doctype html><html><head></head><body><fragment-slot name="billing"></fragment-slot></body></html>', {
          headers: { 'content-type': 'text/html' },
        }),
    );

    const body = await page!.text();
    fetchMock.mockRestore();

    expect(body).toContain('<style>fragment-slot');
    expect(body).not.toContain('nonce=');
  });
});
