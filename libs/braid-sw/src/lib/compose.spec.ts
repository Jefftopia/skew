import { describe, expect, it, vi } from 'vitest';
import { braidNavigationHandler } from './compose.js';

/**
 * Offline composition, which is the claim worth being careful about: a page that composed on the
 * server composes again from cache, with no network, using the same piercing code the gateway runs.
 */

interface Entry {
  response: Response;
}

function memoryCaches(): CacheStorage & { partitions: Map<string, Map<string, Entry>> } {
  const partitions = new Map<string, Map<string, Entry>>();

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
        return store.get(key)?.response.clone();
      },
      async put(request: RequestInfo, response: Response) {
        const key = typeof request === 'string' ? request : (request as Request).url;
        store.set(key, { response });
      },
    } as unknown as Cache;
  };

  return {
    open,
    keys: async () => [...partitions.keys()],
    delete: async (name: string) => partitions.delete(name),
    partitions,
  } as unknown as CacheStorage & { partitions: Map<string, Map<string, Entry>> };
}

const SNAPSHOT = {
  id: 'reg_abc',
  createdAt: '2026-01-01T00:00:00.000Z',
  manifests: [
    { id: 'billing', endpoint: 'https://billing.internal', pierce: ['/billing/*'] },
    { id: 'notifications', endpoint: 'https://n.internal', pierce: ['/', '/*'], bound: false, src: '/panel' },
  ],
};

const html = (body: string) => new Response(body, { headers: { 'content-type': 'text/html' } });

/** The origin, as seen by the worker: online until `offline()` is called. */
function origin() {
  let down = false;
  const asked: string[] = [];

  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const url = new URL(request.url);
    asked.push(`${url.pathname}${request.headers.get('sec-fetch-dest') === 'empty' ? ' (shell)' : ''}`);

    if (down) throw new TypeError('Failed to fetch');

    if (url.pathname === '/registry.json') return new Response(JSON.stringify(SNAPSHOT));
    if (url.pathname.startsWith('/__braid/doc/billing')) return html('<braid-html><braid-body><h1>Invoices</h1></braid-body></braid-html>');
    if (url.pathname.startsWith('/__braid/doc/notifications')) return html('<braid-html><braid-body><p>3 unread</p></braid-body></braid-html>');
    if (request.headers.get('sec-fetch-dest') === 'empty') {
      return html('<html><body><fragment-slot name="billing"></fragment-slot><fragment-slot name="notifications"></fragment-slot></body></html>');
    }
    return html('<html><body>the composed page from the server</body></html>');
  }) as unknown as typeof fetch;

  return { fetchImpl, asked, offline: () => void (down = true) };
}

const navigation = (path: string) =>
  new Request(`https://shop.example${path}`, { headers: { accept: 'text/html' } });

describe('scope', () => {
  it('only answers navigations', () => {
    const handler = braidNavigationHandler({ snapshotUrl: '/registry.json', caches: memoryCaches(), fetch: vi.fn() });

    expect(handler(new Request('https://shop.example/app.js'))).toBeNull();
    expect(handler(new Request('https://shop.example/', { method: 'POST', headers: { accept: 'text/html' } }))).toBeNull();
    expect(handler(navigation('/billing/invoices'))).not.toBeNull();
  });

  it('prefers the network whenever there is one', async () => {
    const server = origin();
    const handler = braidNavigationHandler({
      snapshotUrl: '/registry.json',
      caches: memoryCaches(),
      fetch: server.fetchImpl,
    });

    const response = await handler(navigation('/billing/invoices'))!;

    // The gateway is authoritative. Composing locally while it is reachable would be answering with
    // a copy of an answer we could have simply asked for.
    expect(await response.text()).toContain('the composed page from the server');
  });
});

describe('composing with no network', () => {
  it('pierces cached fragment documents into the cached shell', async () => {
    const server = origin();
    const caches = memoryCaches();
    const composed: unknown[] = [];
    const handler = braidNavigationHandler({
      snapshotUrl: '/registry.json',
      caches,
      fetch: server.fetchImpl,
      onCompose: (event) => composed.push(event),
    });

    // One online visit is what stocks the cache.
    await handler(navigation('/billing/invoices'))!;
    await new Promise((resolve) => setTimeout(resolve, 20));

    server.offline();
    const offline = await handler(navigation('/billing/invoices'))!;
    const body = await offline.text();

    expect(offline.headers.get('x-braid-composed')).toBe('offline');
    expect(body).toContain('<h1>Invoices</h1>');
    expect(body).toContain('<p>3 unread</p>');
    expect(body).toContain('<template shadowrootmode="open">');
    expect(composed).toEqual([{ pathname: '/billing/invoices', fragmentIds: ['billing', 'notifications'] }]);
  });

  it('asks the unbound fragment for its own path, as the server does', async () => {
    const server = origin();
    const handler = braidNavigationHandler({
      snapshotUrl: '/registry.json',
      caches: memoryCaches(),
      fetch: server.fetchImpl,
    });

    await handler(navigation('/billing/invoices'))!;
    await new Promise((resolve) => setTimeout(resolve, 20));

    // A widget's document lives at /panel whatever page it appears on — the same rule the gateway
    // applies, because a second implementation of it is a second set of bugs.
    expect(server.asked).toContain('/__braid/doc/notifications/panel');
    expect(server.asked).toContain('/__braid/doc/billing/billing/invoices');
  });

  it('degrades a fragment it never cached to a placeholder rather than failing the page', async () => {
    const server = origin();
    const caches = memoryCaches();
    const handler = braidNavigationHandler({ snapshotUrl: '/registry.json', caches, fetch: server.fetchImpl });

    await handler(navigation('/billing/invoices'))!;
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The billing fragment's cache is dropped, as an eviction would drop it.
    caches.partitions.delete('braid-frag:billing');

    server.offline();
    const body = await (await handler(navigation('/billing/invoices'))!).text();

    expect(body).toContain('data-braid-fallback="placeholder"');
    expect(body).toContain('<p>3 unread</p>');
  });

  it('gives up honestly when it has no shell for this route', async () => {
    const server = origin();
    const handler = braidNavigationHandler({
      snapshotUrl: '/registry.json',
      caches: memoryCaches(),
      fetch: server.fetchImpl,
    });

    server.offline();

    // Never visited, nothing cached: the offline error is the truth, and inventing a page would be
    // worse than reporting it.
    await expect(handler(navigation('/billing/invoices'))!).rejects.toThrow('Failed to fetch');
  });

  it('caches the shell unpierced, so composition has parts rather than a finished page', async () => {
    const server = origin();
    const caches = memoryCaches();
    const handler = braidNavigationHandler({ snapshotUrl: '/registry.json', caches, fetch: server.fetchImpl });

    await handler(navigation('/billing/invoices'))!;
    await new Promise((resolve) => setTimeout(resolve, 20));

    const shell = await (await caches.open('braid-shell')).match('https://shop.example/billing/invoices');
    const body = await shell!.text();
    expect(body).toContain('<fragment-slot name="billing">');
    expect(body).not.toContain('shadowrootmode');
  });
});

describe('streaming', () => {
  it('interleaves the shell around a fragment that is still arriving', async () => {
    // The plan flags "does streaming composition behave under respondWith" as a thing to verify.
    // The half this package owns is that the composed body is a *stream* — that the shell's opening
    // markup is readable before the fragment's body has finished arriving. Whether a browser then
    // streams that Response through respondWith is the platform's guarantee, not this code's.
    const caches = memoryCaches();
    const shellCache = await caches.open('braid-shell');
    await shellCache.put(
      'https://shop.example/billing/invoices',
      html('<html><body><header>shell</header><fragment-slot name="billing"></fragment-slot><footer>end</footer></body></html>'),
    );
    const snapshotCache = await caches.open('braid-snapshot');
    await snapshotCache.put('https://shop.example/registry.json', new Response(JSON.stringify(SNAPSHOT)));

    // A fragment document that arrives in pieces, slowly.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slowFragment = new ReadableStream<Uint8Array>({
      async start(controller) {
        const encode = (text: string) => new TextEncoder().encode(text);
        controller.enqueue(encode('<braid-html><braid-body><h1>Invoices</h1>'));
        await gate;
        controller.enqueue(encode('<p>tail</p></braid-body></braid-html>'));
        controller.close();
      },
    });
    const fragmentCache = await caches.open('braid-frag:billing');
    await fragmentCache.put(
      'https://shop.example/__braid/doc/billing/billing/invoices',
      new Response(slowFragment, { headers: { 'content-type': 'text/html' } }),
    );

    const handler = braidNavigationHandler({
      snapshotUrl: '/registry.json',
      caches,
      fetch: vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }) as unknown as typeof fetch,
    });

    const response = await handler(navigation('/billing/invoices'))!;
    const reader = response.body!.getReader();

    let seen = '';
    while (!seen.includes('<h1>Invoices</h1>')) {
      const { value, done } = await reader.read();
      if (done) break;
      seen += new TextDecoder().decode(value);
    }

    // The shell's opening markup and the fragment's first chunk are readable while the fragment's
    // body is still open — the page paints with the fragment present rather than after it.
    expect(seen).toContain('<header>shell</header>');
    expect(seen).not.toContain('<footer>end</footer>');

    release();
    let rest = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      rest += new TextDecoder().decode(value);
    }
    expect(rest).toContain('<footer>end</footer>');
  });
});
