import { describe, expect, it } from 'vitest';
import type { DiscoveryEntry } from '@braid/gateway';
import { buildTopology, coTenants, neighborhood, FRAGMENT_PREFIX, ROUTE_PREFIX } from './topology.js';

function entry(overrides: Partial<DiscoveryEntry> & { id: string }): DiscoveryEntry {
  return {
    title: overrides.id,
    adapter: 'compat',
    mount: `/__braid/frag/${overrides.id}/`,
    loadable: true,
    ...overrides,
  };
}

describe('buildTopology', () => {
  it('links a route to every fragment that pierces it', () => {
    const topology = buildTopology([
      entry({ id: 'billing', pierce: ['/billing/*'] }),
      entry({ id: 'reviews', pierce: ['/billing/*'] }),
    ]);

    expect(topology.routes).toHaveLength(1);
    expect(topology.routes[0].label).toBe('/billing/*');
    expect(topology.edges.filter((edge) => edge.kind === 'composes')).toHaveLength(2);
  });

  it('marks a route shared only when more than one fragment pierces it', () => {
    const topology = buildTopology([
      entry({ id: 'billing', pierce: ['/billing/*'] }),
      entry({ id: 'reviews', pierce: ['/billing/*'] }),
      entry({ id: 'payroll', pierce: ['/payroll/*'] }),
    ]);

    const byLabel = Object.fromEntries(topology.routes.map((route) => [route.label, route]));
    expect(byLabel['/billing/*'].shared).toBe(true);
    expect(byLabel['/payroll/*'].shared).toBe(false);
  });

  it('groups fragments served by the same origin', () => {
    const topology = buildTopology([
      entry({ id: 'billing', endpoint: 'http://shared.internal:9101/billing' }),
      entry({ id: 'invoices', endpoint: 'http://shared.internal:9101/invoices' }),
    ]);

    expect(topology.origins).toHaveLength(1);
    expect(topology.origins[0].label).toBe('shared.internal:9101');
    expect(topology.origins[0].degree).toBe(2);
  });

  // A production listing withholds endpoints. That is the gateway working, so the column is
  // reported as unavailable rather than drawn empty.
  it('reports origins as unknown when no entry carries an endpoint', () => {
    const topology = buildTopology([entry({ id: 'billing', pierce: ['/billing/*'] })]);

    expect(topology.origins).toHaveLength(0);
    expect(topology.originsUnknown).toBe(true);
  });

  it('does not claim unknown origins for an empty registry', () => {
    expect(buildTopology([]).originsUnknown).toBe(false);
  });

  // An unbound widget has no pierce pattern, so no route can honestly claim it.
  it('collects fragments that no route pierces', () => {
    const topology = buildTopology([
      entry({ id: 'billing', pierce: ['/billing/*'] }),
      entry({ id: 'rating' }),
    ]);

    expect(topology.unrouted.map((node) => node.label)).toEqual(['rating']);
  });

  it('sorts routes by how many fragments they carry, busiest first', () => {
    const topology = buildTopology([
      entry({ id: 'a', pierce: ['/quiet/*'] }),
      entry({ id: 'b', pierce: ['/busy/*'] }),
      entry({ id: 'c', pierce: ['/busy/*'] }),
    ]);

    expect(topology.routes.map((route) => route.label)).toEqual(['/busy/*', '/quiet/*']);
  });

  it('ignores an endpoint that is not a URL rather than inventing an origin', () => {
    const topology = buildTopology([entry({ id: 'billing', endpoint: 'not a url' })]);

    expect(topology.origins).toHaveLength(0);
  });
});

describe('neighborhood', () => {
  const entries = [
    entry({ id: 'billing', pierce: ['/billing/*'], endpoint: 'http://one:9101' }),
    entry({ id: 'reviews', pierce: ['/billing/*'], endpoint: 'http://two:9102' }),
    entry({ id: 'payroll', pierce: ['/payroll/*'], endpoint: 'http://three:9103' }),
  ];

  it('is empty with nothing selected', () => {
    expect(neighborhood(buildTopology(entries), null).nodes.size).toBe(0);
  });

  it('reaches the fragments a route composes', () => {
    const topology = buildTopology(entries);
    const lit = neighborhood(topology, `${ROUTE_PREFIX}/billing/*`);

    expect(lit.nodes.has(`${FRAGMENT_PREFIX}billing`)).toBe(true);
    expect(lit.nodes.has(`${FRAGMENT_PREFIX}reviews`)).toBe(true);
    expect(lit.nodes.has(`${FRAGMENT_PREFIX}payroll`)).toBe(false);
  });

  // Selecting a fragment answers "who else is on this page with me?", which needs the extra hop
  // through the shared route.
  it('reaches co-tenants from a fragment', () => {
    const topology = buildTopology(entries);
    const lit = neighborhood(topology, `${FRAGMENT_PREFIX}billing`);

    expect(lit.nodes.has(`${FRAGMENT_PREFIX}reviews`)).toBe(true);
    expect(lit.nodes.has(`${FRAGMENT_PREFIX}payroll`)).toBe(false);
  });
});

describe('coTenants', () => {
  it('lists the fragments sharing a route, and not the fragment itself', () => {
    const topology = buildTopology([
      entry({ id: 'billing', pierce: ['/billing/*'] }),
      entry({ id: 'reviews', pierce: ['/billing/*'] }),
      entry({ id: 'payroll', pierce: ['/payroll/*'] }),
    ]);

    expect(coTenants(topology, `${FRAGMENT_PREFIX}billing`)).toEqual([`${FRAGMENT_PREFIX}reviews`]);
    expect(coTenants(topology, `${FRAGMENT_PREFIX}payroll`)).toEqual([]);
  });
});
