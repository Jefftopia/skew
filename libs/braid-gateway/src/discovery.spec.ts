import { describe, expect, it, vi } from 'vitest';
import { createGateway } from './gateway.js';
import { DiscoveryPage } from './discovery.js';
import type { FragmentManifest } from './registry.js';

const manifests: FragmentManifest[] = [
  { id: 'billing', endpoint: 'https://billing.internal', title: 'Billing', pierce: ['/billing/*'] },
  { id: 'catalog', endpoint: 'https://catalog.internal', description: 'Product catalog', tags: ['shop'] },
  {
    id: 'payroll',
    endpoint: 'https://payroll.internal',
    access: { list: { roles: ['finance', 'admin'] } },
  },
  {
    id: 'secrets',
    endpoint: 'https://secrets.internal',
    access: { list: { scopes: ['secrets:read', 'secrets:list'] } },
  },
];

function gatewayWithDiscovery(
  discovery: Parameters<typeof createGateway>[0]['discovery'] = {},
  principal?: Parameters<typeof createGateway>[0]['principal'],
) {
  return createGateway({ registry: manifests, mode: 'production', discovery, principal });
}

const listing = (url = 'https://example.com/__braid/registry', init?: RequestInit) =>
  new Request(url, init);

async function read(response: Response | null): Promise<DiscoveryPage> {
  return (await response!.json()) as DiscoveryPage;
}

describe('discovery endpoint', () => {
  it('is not published unless configured', async () => {
    const gateway = createGateway({ registry: manifests, mode: 'production' });

    expect(await gateway.handle(listing())).toBeNull();
  });

  it('lists public fragments with their mount path', async () => {
    const page = await read(await gatewayWithDiscovery().handle(listing()));

    expect(page.items.map((item) => item.id)).toEqual(['billing', 'catalog']);
    expect(page.items[0]).toMatchObject({
      id: 'billing',
      title: 'Billing',
      adapter: 'compat',
      mount: '/__braid/frag/billing/',
      pierce: ['/billing/*'],
    });
    expect(page.items[1]).toMatchObject({ title: 'catalog', description: 'Product catalog', tags: ['shop'] });
    expect(page.total).toBe(2);
  });

  it('withholds internal endpoints by default', async () => {
    const page = await read(await gatewayWithDiscovery().handle(listing()));

    for (const item of page.items) {
      expect(item.endpoint).toBeUndefined();
    }
  });

  it('includes endpoints when explicitly asked to', async () => {
    const page = await read(await gatewayWithDiscovery({ includeEndpoints: true }).handle(listing()));

    expect(page.items[0].endpoint).toBe('https://billing.internal');
  });

  it('never lets a listing into a shared cache', async () => {
    const response = await gatewayWithDiscovery().handle(listing());

    expect(response!.headers.get('cache-control')).toBe('no-store');
    expect(response!.headers.get('vary')).toContain('cookie');
  });

  describe('roles and scopes', () => {
    const withPrincipal = (roles: string[] = [], scopes: string[] = []) =>
      gatewayWithDiscovery({}, () => ({ roles, scopes }));

    it('reveals a role-gated fragment to a caller holding any required role', async () => {
      const page = await read(await withPrincipal(['finance']).handle(listing()));

      expect(page.items.map((item) => item.id)).toContain('payroll');
    });

    it('hides a role-gated fragment from a caller without one', async () => {
      const page = await read(await withPrincipal(['support']).handle(listing()));

      expect(page.items.map((item) => item.id)).not.toContain('payroll');
    });

    it('requires every listed scope, not just one', async () => {
      const partial = await read(await withPrincipal([], ['secrets:read']).handle(listing()));
      expect(partial.items.map((item) => item.id)).not.toContain('secrets');

      const complete = await read(await withPrincipal([], ['secrets:read', 'secrets:list']).handle(listing()));
      expect(complete.items.map((item) => item.id)).toContain('secrets');
    });

    it('treats a caller with no principal resolver as anonymous', async () => {
      const page = await read(await gatewayWithDiscovery().handle(listing()));

      expect(page.items.map((item) => item.id)).toEqual(['billing', 'catalog']);
      expect(page.total).toBe(2);
    });

    it('passes the request to the principal resolver', async () => {
      const principal = vi.fn(() => ({ roles: ['admin'] }));
      const request = listing('https://example.com/__braid/registry', {
        headers: { authorization: 'Bearer token' },
      });

      await gatewayWithDiscovery({}, principal).handle(request);

      expect((principal.mock.calls[0][0] as Request).headers.get('authorization')).toBe('Bearer token');
    });

    it('marks entries the caller may list but not load', async () => {
      // listing and loading are separate rules, so a launcher can show an app it cannot open
      const gateway = createGateway({
        registry: [
          { id: 'reports', endpoint: 'https://reports.internal', access: { fetch: { roles: ['analyst'] } } },
        ],
        mode: 'production',
        discovery: {},
        principal: () => ({ roles: [] }),
      });

      const page = await read(await gateway.handle(listing()));

      expect(page.items).toHaveLength(1);
      expect(page.items[0].loadable).toBe(false);
    });

    it('marks entries the caller may load', async () => {
      const page = await read(await withPrincipal(['finance']).handle(listing()));

      expect(page.items.every((item) => item.loadable)).toBe(true);
    });
  });

  describe('pagination', () => {
    const many = Array.from({ length: 250 }, (_, index) => ({
      id: `frag-${String(index).padStart(3, '0')}`,
      endpoint: `https://frag-${index}.internal`,
    }));
    const bigGateway = (discovery = {}) =>
      createGateway({ registry: many, mode: 'production', discovery });

    it('defaults to 100 per page', async () => {
      const page = await read(await bigGateway().handle(listing()));

      expect(page.pageSize).toBe(100);
      expect(page.items).toHaveLength(100);
      expect(page.total).toBe(250);
      expect(page.totalPages).toBe(3);
      expect(page.hasMore).toBe(true);
    });

    it('walks pages in a stable order with no gaps or repeats', async () => {
      const seen: string[] = [];
      for (const pageNumber of [1, 2, 3]) {
        const page = await read(
          await bigGateway().handle(listing(`https://example.com/__braid/registry?page=${pageNumber}`)),
        );
        seen.push(...page.items.map((item) => item.id));
      }

      expect(seen).toHaveLength(250);
      expect(new Set(seen).size).toBe(250);
      expect(seen[0]).toBe('frag-000');
      expect(seen.at(-1)).toBe('frag-249');
    });

    it('reports the last page as having no more', async () => {
      const page = await read(await bigGateway().handle(listing('https://example.com/__braid/registry?page=3')));

      expect(page.items).toHaveLength(50);
      expect(page.hasMore).toBe(false);
    });

    it('caps a caller-requested page size at the maximum', async () => {
      const page = await read(
        await bigGateway().handle(listing('https://example.com/__braid/registry?pageSize=5000')),
      );

      expect(page.pageSize).toBe(100);
      expect(page.items).toHaveLength(100);
    });

    it('honors a configured page size and ceiling', async () => {
      const page = await read(
        await bigGateway({ pageSize: 10, maxPageSize: 25 }).handle(
          listing('https://example.com/__braid/registry?pageSize=1000'),
        ),
      );

      expect(page.pageSize).toBe(25);
    });

    it('falls back to sane values for nonsense input', async () => {
      const page = await read(
        await bigGateway().handle(listing('https://example.com/__braid/registry?page=-4&pageSize=0')),
      );

      expect(page.page).toBe(1);
      expect(page.pageSize).toBe(100);
    });

    it('clamps a page beyond the end to the last page', async () => {
      const page = await read(await bigGateway().handle(listing('https://example.com/__braid/registry?page=99')));

      expect(page.page).toBe(3);
    });
  });

  describe('development mode', () => {
    it('returns everything, unfiltered, with endpoints', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const gateway = createGateway({ registry: manifests, mode: 'development', discovery: {} });

      const page = await read(await gateway.handle(listing()));

      expect(page.items.map((item) => item.id)).toEqual(['billing', 'catalog', 'payroll', 'secrets']);
      expect(page.unfiltered).toBe(true);
      expect(page.items[0].endpoint).toBe('https://billing.internal');
      // and it says so, because this is the configuration you must not ship
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('development mode'));
      warn.mockRestore();
    });
  });

  it('serves at a configured path', async () => {
    const gateway = gatewayWithDiscovery({ path: '/internal/apps' });

    expect(await gateway.handle(listing('https://example.com/__braid/registry'))).toBeNull();
    expect((await gateway.handle(listing('https://example.com/internal/apps')))!.status).toBe(200);
  });

  it('rejects non-GET methods', async () => {
    const response = await gatewayWithDiscovery().handle(listing(undefined, { method: 'POST' }));

    expect(response!.status).toBe(405);
    expect(response!.headers.get('allow')).toContain('GET');
  });
});
