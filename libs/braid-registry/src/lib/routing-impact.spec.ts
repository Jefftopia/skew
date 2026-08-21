import { describe, expect, it } from 'vitest';
import type { FragmentManifest, RoutingEvent } from '@braid/gateway';
import { createRoutingObservations, parseObservations, serializeObservations } from './observations.js';
import { routingImpact } from './routing-impact.js';

const billing: FragmentManifest = { id: 'billing', endpoint: 'https://b.internal', pierce: ['/billing/*'] };
const reviews: FragmentManifest = { id: 'reviews', endpoint: 'https://r.internal', pierce: ['/reviews/*'] };

const event = (pathname: string, fragmentIds: string[] = []): RoutingEvent => ({
  pathname,
  fragmentIds,
  at: Date.parse('2026-08-14T00:00:00Z'),
});

function observed(entries: [string, number, string[]?][]) {
  const observations = createRoutingObservations();
  for (const [pathname, times, ids] of entries) {
    for (let i = 0; i < times; i++) observations.record(event(pathname, ids ?? []));
  }
  return observations.snapshot();
}

describe('createRoutingObservations', () => {
  it('aggregates repeats rather than logging every request', () => {
    const set = observed([['/billing/invoices', 3, ['billing']]]);

    expect(set.paths).toHaveLength(1);
    expect(set.paths[0]).toMatchObject({ pathname: '/billing/invoices', count: 3, fragmentIds: ['billing'] });
    expect(set.totalRequests).toBe(3);
  });

  it('orders by traffic, so a truncated read still shows what matters', () => {
    const set = observed([
      ['/quiet', 1],
      ['/busy', 9],
    ]);

    expect(set.paths.map((path) => path.pathname)).toEqual(['/busy', '/quiet']);
  });

  it('bounds memory by evicting the least recently seen path', () => {
    const observations = createRoutingObservations({ maxPaths: 2 });
    observations.record(event('/a'));
    observations.record(event('/b'));
    observations.record(event('/a')); // /a is now more recent than /b
    observations.record(event('/c')); // evicts /b

    const set = observations.snapshot();
    expect(set.paths.map((path) => path.pathname).sort()).toEqual(['/a', '/c']);
    expect(set.evicted).toBe(1);
  });

  it('counts evicted requests in the total, so the sample size stays honest', () => {
    const observations = createRoutingObservations({ maxPaths: 1 });
    observations.record(event('/a'));
    observations.record(event('/b'));

    expect(observations.snapshot().totalRequests).toBe(2);
  });

  it('takes the most recent composition, which reflects the current registry', () => {
    const observations = createRoutingObservations();
    observations.record(event('/billing/x', ['billing']));
    observations.record(event('/billing/x', ['billing', 'reviews']));

    expect(observations.snapshot().paths[0]?.fragmentIds).toEqual(['billing', 'reviews']);
  });

  describe('redaction', () => {
    it('collapses variable segments, which also collapses cardinality', () => {
      const observations = createRoutingObservations({
        redact: (pathname) => pathname.replace(/\/users\/[^/]+/, '/users/:id'),
      });
      observations.record(event('/users/ada@example.com'));
      observations.record(event('/users/grace@example.com'));

      const set = observations.snapshot();
      expect(set.paths).toHaveLength(1);
      expect(set.paths[0]?.pathname).toBe('/users/:id');
      expect(set.paths[0]?.count).toBe(2);
    });

    it('drops a path entirely when the redactor returns null', () => {
      const observations = createRoutingObservations({ redact: () => null });
      observations.record(event('/secret'));

      expect(observations.snapshot().paths).toEqual([]);
      expect(observations.snapshot().totalRequests).toBe(0);
    });
  });

  it('round-trips through serialize/parse', () => {
    const set = observed([['/billing/x', 2, ['billing']]]);

    expect(parseObservations(serializeObservations(set))).toEqual(set);
  });

  it('rejects json that is not an observation set', () => {
    expect(() => parseObservations('{"nope":true}')).toThrow(/not an observation set/);
  });
});

describe('routingImpact', () => {
  it('reports nothing when routing does not change', async () => {
    const impact = await routingImpact(observed([['/billing/x', 5]]), [billing], [{ ...billing, title: 'Renamed' }]);

    expect(impact.unchanged).toBe(true);
    expect(impact.paths).toEqual([]);
  });

  it('counts the traffic a narrowed pattern stops composing on', async () => {
    const set = observed([
      ['/billing/invoices', 40],
      ['/billing/settings', 3],
    ]);

    const impact = await routingImpact(set, [billing], [{ ...billing, pierce: ['/billing/invoices'] }]);

    expect(impact.affectedPaths).toBe(1);
    expect(impact.affectedRequests).toBe(3);
    expect(impact.paths[0]).toMatchObject({ pathname: '/billing/settings', lost: ['billing'], gained: [] });
  });

  it('rolls up per fragment, which is usually the headline', async () => {
    const set = observed([
      ['/billing/a', 10],
      ['/billing/b', 7],
    ]);

    const impact = await routingImpact(set, [billing], []);

    expect(impact.byFragment).toEqual([
      { fragmentId: 'billing', lostPaths: 2, lostRequests: 17, gainedPaths: 0, gainedRequests: 0 },
    ]);
  });

  it('reports gains on paths that composed nothing before', async () => {
    // the reason every document request is observed, not only pierce-matched ones
    const set = observed([['/reports/q3', 12]]);

    const impact = await routingImpact(set, [billing], [billing, { ...reviews, pierce: ['/reports/*'] }]);

    expect(impact.paths[0]).toMatchObject({ pathname: '/reports/q3', gained: ['reviews'], lost: [] });
    expect(impact.byFragment[0]).toMatchObject({ fragmentId: 'reviews', gainedRequests: 12 });
  });

  it('orders affected paths by traffic', async () => {
    const set = observed([
      ['/billing/quiet', 2],
      ['/billing/busy', 99],
    ]);

    const impact = await routingImpact(set, [billing], []);

    expect(impact.paths.map((path) => path.pathname)).toEqual(['/billing/busy', '/billing/quiet']);
  });

  it('honors the trailing-slash tolerance the gateway actually applies', async () => {
    // `/billing/*` matches `/billing` in the gateway; an analysis that missed this would report a
    // loss that will not happen
    const impact = await routingImpact(observed([['/billing', 5]]), [billing], [billing]);

    expect(impact.unchanged).toBe(true);
  });

  it('flags a capped observation set as a sample', async () => {
    const observations = createRoutingObservations({ maxPaths: 1 });
    observations.record(event('/billing/a'));
    observations.record(event('/billing/b'));

    const impact = await routingImpact(observations.snapshot(), [billing], []);

    expect(impact.sampled).toBe(true);
    expect(impact.observed.evicted).toBe(1);
  });

  it('is not a sample when nothing was evicted', async () => {
    expect((await routingImpact(observed([['/billing/a', 1]]), [billing], [])).sampled).toBe(false);
  });

  describe('tolerating an unpublishable draft', () => {
    it('treats a manifest with no endpoint as composing nothing', async () => {
      const incomplete = [{ id: 'new-fragment', endpoint: '', pierce: ['/billing/*'] }] as FragmentManifest[];

      const impact = await routingImpact(observed([['/billing/a', 1]]), [billing], incomplete);

      expect(impact.byFragment).toEqual([
        { fragmentId: 'billing', lostPaths: 1, lostRequests: 1, gainedPaths: 0, gainedRequests: 0 },
      ]);
    });

    it('ignores an uncompilable pattern rather than throwing', async () => {
      const broken = [{ ...billing, pierce: ['/billing/((('] }];

      await expect(routingImpact(observed([['/billing/a', 1]]), [billing], broken)).resolves.toBeDefined();
    });
  });
});
