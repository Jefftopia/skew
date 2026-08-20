import { describe, expect, it, vi } from 'vitest';
import { createGateway } from './gateway.js';
import { parseVitalsBeacon, rateVital, vitalsCollectorScript, type TelemetryEvent } from './telemetry.js';
import { BRAID_VITALS_BEACON_PATH, BRAID_VITALS_SCRIPT_PATH } from './protocol.js';

/** Named, because an inline `() => {}` is an eslint error and a comment is cheaper than a disable. */
const noop = (): void => undefined;

const html = (body: string) =>
  new Response(`<!doctype html><html><head><title>t</title></head><body>${body}</body></html>`, {
    headers: { 'content-type': 'text/html' },
  });

describe('rateVital', () => {
  it('rates against the web.dev thresholds, boundaries inclusive of the better bucket', () => {
    expect(rateVital('LCP', 2500)).toBe('good');
    expect(rateVital('LCP', 2501)).toBe('needs-improvement');
    expect(rateVital('LCP', 4001)).toBe('poor');
    expect(rateVital('CLS', 0.1)).toBe('good');
    expect(rateVital('CLS', 0.3)).toBe('poor');
  });
});

describe('parseVitalsBeacon', () => {
  const known = new Set(['billing']);

  it('parses a well-formed beacon and rates each metric', () => {
    const events = parseVitalsBeacon(
      { pathname: '/billing', metrics: [{ name: 'LCP', value: 1200, fragmentId: 'billing' }] },
      known,
      1000,
    );

    expect(events).toEqual([
      {
        kind: 'web-vital',
        name: 'LCP',
        value: 1200,
        rating: 'good',
        fragmentId: 'billing',
        pathname: '/billing',
        at: 1000,
      },
    ]);
  });

  // The endpoint is reachable by anyone who can load the page, so a fragment id it does not
  // recognise must not be relayed to the sink as though the gateway vouched for it.
  it('nulls a fragment id that is not registered rather than forwarding it', () => {
    const [event] = parseVitalsBeacon(
      { pathname: '/x', metrics: [{ name: 'LCP', value: 1, fragmentId: 'not-a-fragment' }] },
      known,
    );

    expect(event.fragmentId).toBeNull();
  });

  it('drops metrics that are not real vitals or not finite positive numbers', () => {
    const events = parseVitalsBeacon(
      {
        pathname: '/x',
        metrics: [
          { name: 'NOT_A_VITAL', value: 1 },
          { name: 'LCP', value: Number.NaN },
          { name: 'LCP', value: -1 },
          { name: 'LCP', value: '900' },
          { name: 'CLS', value: 0.05 },
        ],
      },
      known,
    );

    expect(events).toHaveLength(1);
    expect(events[0].name).toBe('CLS');
  });

  it('strips the query from the reported pathname and caps its length', () => {
    const [event] = parseVitalsBeacon(
      { pathname: `/billing?token=secret${'x'.repeat(900)}`, metrics: [{ name: 'TTFB', value: 10 }] },
      known,
    );

    expect(event.pathname).toBe('/billing');
    expect(event.pathname.length).toBeLessThanOrEqual(512);
  });

  it('caps how many metrics one beacon can contribute', () => {
    const metrics = Array.from({ length: 100 }, () => ({ name: 'LCP', value: 1 }));
    expect(parseVitalsBeacon({ pathname: '/x', metrics }, known)).toHaveLength(32);
  });

  it('returns nothing for a body that is not shaped like a beacon', () => {
    expect(parseVitalsBeacon(null, known)).toEqual([]);
    expect(parseVitalsBeacon('nope', known)).toEqual([]);
    expect(parseVitalsBeacon({ pathname: '/x' }, known)).toEqual([]);
    expect(parseVitalsBeacon({ metrics: [] }, known)).toEqual([]);
  });
});

describe('vitalsCollectorScript', () => {
  it('bakes in the endpoint and the sample rate', () => {
    const script = vitalsCollectorScript('/__braid/vitals', 0.25);
    expect(script).toContain('"/__braid/vitals"');
    expect(script).toContain('Math.random() >= 0.25');
  });
});

describe('gateway telemetry', () => {
  const registry = [{ id: 'billing', endpoint: 'https://billing.test', pierce: ['/billing/*'] }];

  it('reports a successful fragment fetch with its status and phase', async () => {
    const events: TelemetryEvent[] = [];
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(html('<p>ok</p>'));

    const gateway = createGateway({ registry, telemetry: { on: (event) => events.push(event) } });
    await gateway.handle(
      new Request('https://shell.test/billing/invoices', { headers: { 'sec-fetch-dest': 'document' } }),
      async () => html('<fragment-slot name="billing"></fragment-slot>'),
    );

    fetchMock.mockRestore();

    const fetched = events.filter((event) => event.kind === 'fragment-fetch');
    expect(fetched).toHaveLength(1);
    expect(fetched[0]).toMatchObject({ fragmentId: 'billing', phase: 'pierce', outcome: 'ok', status: 200 });
    expect((fetched[0] as { durationMs: number }).durationMs).toBeGreaterThanOrEqual(0);
  });

  it('reports a fetch that threw as an error', async () => {
    const events: TelemetryEvent[] = [];
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unreachable'));

    const gateway = createGateway({ registry, telemetry: { on: (event) => events.push(event) } });
    await gateway.handle(
      new Request('https://shell.test/billing/invoices', { headers: { 'sec-fetch-dest': 'document' } }),
      async () => html('<fragment-slot name="billing"></fragment-slot>'),
    );

    fetchMock.mockRestore();
    expect(events[0]).toMatchObject({ kind: 'fragment-fetch', outcome: 'error', fragmentId: 'billing' });
  });

  // The hook is meant to be safe to leave on in production, so a bad sink must not be able to
  // fail the request it was describing.
  it('survives a telemetry hook that throws, and mutes it rather than flooding', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(html('<p>ok</p>'));
    const on = vi.fn(() => {
      throw new Error('sink is down');
    });

    const gateway = createGateway({ registry, telemetry: { on } });
    const request = () =>
      gateway.handle(
        new Request('https://shell.test/billing/invoices', { headers: { 'sec-fetch-dest': 'document' } }),
        async () => html('<fragment-slot name="billing"></fragment-slot>'),
      );

    await expect(request()).resolves.not.toBeNull();
    await expect(request()).resolves.not.toBeNull();

    expect(on).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledTimes(1);

    fetchMock.mockRestore();
    error.mockRestore();
  });

  it('serves no collector and injects no script unless webVitals is on', async () => {
    const gateway = createGateway({ registry, telemetry: { on: noop } });

    expect(await gateway.handle(new Request(`https://shell.test${BRAID_VITALS_SCRIPT_PATH}`))).toBeNull();
  });

  it('serves the collector and injects it into a composed document when webVitals is on', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(html('<p>ok</p>'));
    const gateway = createGateway({ registry, telemetry: { on: noop, webVitals: true } });

    const script = await gateway.handle(new Request(`https://shell.test${BRAID_VITALS_SCRIPT_PATH}`));
    expect(script?.headers.get('content-type')).toContain('text/javascript');

    const page = await gateway.handle(
      new Request('https://shell.test/billing/invoices', { headers: { 'sec-fetch-dest': 'document' } }),
      async () => html('<fragment-slot name="billing"></fragment-slot>'),
    );
    const body = await page!.text();

    fetchMock.mockRestore();
    expect(body).toContain(`<script src="${BRAID_VITALS_SCRIPT_PATH}" defer></script>`);
  });

  it('accepts a beacon and emits its metrics', async () => {
    const events: TelemetryEvent[] = [];
    const gateway = createGateway({ registry, telemetry: { on: (event) => events.push(event), webVitals: true } });

    const response = await gateway.handle(
      new Request(`https://shell.test${BRAID_VITALS_BEACON_PATH}`, {
        method: 'POST',
        body: JSON.stringify({ pathname: '/billing', metrics: [{ name: 'CLS', value: 0.4, fragmentId: 'billing' }] }),
      }),
    );

    expect(response?.status).toBe(204);
    expect(events).toEqual([
      expect.objectContaining({ kind: 'web-vital', name: 'CLS', rating: 'poor', fragmentId: 'billing' }),
    ]);
  });

  it('answers 204 for a malformed beacon rather than describing what it rejected', async () => {
    const events: TelemetryEvent[] = [];
    const gateway = createGateway({ registry, telemetry: { on: (event) => events.push(event), webVitals: true } });

    const response = await gateway.handle(
      new Request(`https://shell.test${BRAID_VITALS_BEACON_PATH}`, { method: 'POST', body: 'not json' }),
    );

    expect(response?.status).toBe(204);
    expect(events).toEqual([]);
  });
});
