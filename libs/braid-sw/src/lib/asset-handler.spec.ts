import { describe, expect, it, vi } from 'vitest';
import { braidFetchHandler, pruneFragmentCaches } from './asset-handler.js';
import { precacheRealmStubs } from './precache.js';

/**
 * The test that matters is the deploy one: a page asks for a chunk the origin no longer has, and
 * gets it anyway. Everything else here is about not overreaching — a worker that answers requests
 * it should not is worse than no worker, because its mistakes look like application bugs.
 */

/** A `CacheStorage` good enough to test against: real key semantics, no browser. */
function memoryCaches(): CacheStorage & { partitions: Map<string, Map<string, Response>> } {
  const partitions = new Map<string, Map<string, Response>>();

  const open = async (name: string) => {
    let entries = partitions.get(name);
    if (!entries) {
      entries = new Map();
      partitions.set(name, entries);
    }
    const store = entries;
    return {
      async match(request: RequestInfo) {
        const key = typeof request === 'string' ? request : (request as Request).url;
        const hit = store.get(key);
        return hit ? hit.clone() : undefined;
      },
      async put(request: RequestInfo, response: Response) {
        const key = typeof request === 'string' ? request : (request as Request).url;
        store.set(key, response);
      },
    } as unknown as Cache;
  };

  return {
    open,
    keys: async () => [...partitions.keys()],
    delete: async (name: string) => partitions.delete(name),
    partitions,
  } as unknown as CacheStorage & { partitions: Map<string, Map<string, Response>> };
}

const chunk = (id: string) => `https://shop.example/__braid/frag/${id}/main.abc123.js`;

describe('scope', () => {
  it('returns null for anything outside the braid namespace', () => {
    const handler = braidFetchHandler({ caches: memoryCaches(), fetch: vi.fn() });

    expect(handler(new Request('https://shop.example/app.js'))).toBeNull();
    expect(handler(new Request('https://shop.example/'))).toBeNull();
    // The shell composing this into its own worker keeps ownership of its own routes.
    expect(handler(new Request('https://shop.example/api/orders'))).toBeNull();
  });

  it('returns null for non-GET requests', () => {
    const handler = braidFetchHandler({ caches: memoryCaches(), fetch: vi.fn() });

    // A cache cannot answer a POST, and pretending otherwise turns a failed write into a stale
    // success.
    expect(handler(new Request(chunk('billing'), { method: 'POST' }))).toBeNull();
  });

  it('answers for fragment assets and realm stubs', () => {
    const handler = braidFetchHandler({ caches: memoryCaches(), fetch: vi.fn(async () => new Response('')) });

    expect(handler(new Request(chunk('billing')))).not.toBeNull();
    expect(handler(new Request('https://shop.example/__braid/realm/billing/'))).not.toBeNull();
  });
});

describe('serving an open page through a deploy', () => {
  it('serves the chunk the old page was built against after the origin drops it', async () => {
    const caches = memoryCaches();
    const reports: string[] = [];
    let deployed = false;

    const fetchImpl = vi.fn(async () =>
      deployed ? new Response('gone', { status: 404 }) : new Response('export const v = 1;', { status: 200 }),
    );
    const handler = braidFetchHandler({
      caches,
      fetch: fetchImpl,
      onReport: (report) => reports.push(report.outcome),
    });

    // The page loads normally, and the worker keeps a copy on the way past.
    expect(await (await handler(new Request(chunk('billing')))!).text()).toBe('export const v = 1;');

    // A deploy lands. The page is still open, and asks for a lazy route.
    deployed = true;
    const afterDeploy = await handler(new Request(chunk('billing')))!;

    expect(afterDeploy.status).toBe(200);
    expect(await afterDeploy.text()).toBe('export const v = 1;');
    expect(reports).toEqual(['network', 'cache-after-404']);
  });

  it('lets a 404 through when it never cached the asset', async () => {
    const caches = memoryCaches();
    const handler = braidFetchHandler({
      caches,
      fetch: vi.fn(async () => new Response('gone', { status: 404 })),
    });

    expect((await handler(new Request(chunk('billing')))!).status).toBe(404);
  });

  it('does not answer a 500 from cache', async () => {
    const caches = memoryCaches();
    let failing = false;
    const handler = braidFetchHandler({
      caches,
      fetch: vi.fn(async () => (failing ? new Response('boom', { status: 500 }) : new Response('ok'))),
    });

    await handler(new Request(chunk('billing')));
    failing = true;

    // A 500 is the server having a bad moment about an asset that still exists. Papering over it
    // would hide an outage and make it someone else's mystery.
    expect((await handler(new Request(chunk('billing')))!).status).toBe(500);
  });

  it('falls back to cache when the network is gone entirely', async () => {
    const caches = memoryCaches();
    let offline = false;
    const handler = braidFetchHandler({
      caches,
      fetch: vi.fn(async () => {
        if (offline) throw new TypeError('Failed to fetch');
        return new Response('export const v = 1;');
      }),
    });

    await handler(new Request(chunk('billing')));
    offline = true;

    expect(await (await handler(new Request(chunk('billing')))!).text()).toBe('export const v = 1;');
  });

  it('rethrows offline when it has nothing cached', async () => {
    const handler = braidFetchHandler({
      caches: memoryCaches(),
      fetch: vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    });

    await expect(handler(new Request(chunk('billing')))!).rejects.toThrow('Failed to fetch');
  });
});

describe('cache partitions', () => {
  it('gives each fragment its own partition', async () => {
    const caches = memoryCaches();
    const handler = braidFetchHandler({ caches, fetch: vi.fn(async () => new Response('js')) });

    await handler(new Request(chunk('billing')));
    await handler(new Request(chunk('notifications')));

    // Fragment A at build 5 and fragment B at build 12 coexist: there is no shared cache generation
    // for one deploy to invalidate on the other's behalf.
    expect([...caches.partitions.keys()].sort()).toEqual(['braid-frag:billing', 'braid-frag:notifications']);
  });

  it('prunes only fragments that left the registry', async () => {
    const caches = memoryCaches();
    const handler = braidFetchHandler({ caches, fetch: vi.fn(async () => new Response('js')) });
    await handler(new Request(chunk('billing')));
    await handler(new Request(chunk('retired')));

    const removed = await pruneFragmentCaches(['billing'], { caches });

    expect(removed).toEqual(['braid-frag:retired']);
    // The surviving fragment keeps its old chunks — throwing those away is throwing away the thing
    // this handler exists to keep.
    expect(caches.partitions.has('braid-frag:billing')).toBe(true);
  });
});

describe('realm stub precache', () => {
  it('caches each fragment stub, and survives one that fails', async () => {
    const caches = memoryCaches();
    const result = await precacheRealmStubs(['billing', 'broken'], {
      caches,
      origin: 'https://shop.example',
      fetch: vi.fn(async (input) =>
        String(input).includes('broken') ? new Response('', { status: 503 }) : new Response('<html>stub</html>'),
      ) as unknown as typeof fetch,
    });

    expect(result.cached).toEqual(['https://shop.example/__braid/realm/billing/']);
    expect(result.failed).toEqual([{ url: 'https://shop.example/__braid/realm/broken/', reason: 'HTTP 503' }]);
  });

  it('serves a precached stub with no network at all', async () => {
    const caches = memoryCaches();
    await precacheRealmStubs(['billing'], {
      caches,
      origin: 'https://shop.example',
      fetch: vi.fn(async () => new Response('<html>stub</html>')) as unknown as typeof fetch,
    });

    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    const handler = braidFetchHandler({ caches, fetch: fetchImpl });
    const response = await handler(new Request('https://shop.example/__braid/realm/billing/'))!;

    expect(await response.text()).toBe('<html>stub</html>');
  });
});
