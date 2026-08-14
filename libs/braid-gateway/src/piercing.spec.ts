import { describe, expect, it, vi } from 'vitest';
import { createGateway, toWebMiddleware } from './gateway.js';
import { prepareFragmentHtml, pierceShellHtml } from './rewriter/transforms.js';

function streamOf(html: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(html));
      controller.close();
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(stream).text();
}

function htmlResponse(body: string, init: ResponseInit = {}): Response {
  return new Response(body, { headers: { 'content-type': 'text/html;charset=utf-8' }, ...init });
}

describe('prepareFragmentHtml()', () => {
  it('rewrites the document singletons and neutralizes executables', async () => {
    const output = await collect(
      prepareFragmentHtml(
        streamOf(
          `<!doctype html><html lang="en"><head>` +
            `<link rel="modulepreload" href="/m.js"><link rel="stylesheet" href="/s.css">` +
            `</head><body><h1>Bill</h1><script type="module" src="/a.js"></script></body></html>`,
        ),
        { fragmentId: 'billing' },
      ),
    );

    expect(output).not.toContain('<!doctype');
    expect(output).toContain('<braid-html lang="en">');
    expect(output).toContain('</braid-head>');
    expect(output).toContain('</braid-body></braid-html>');
    // every subresource the fragment references is re-rooted into its own namespace
    expect(output).toContain('<link rel="inert-modulepreload" href="/__braid/frag/billing/m.js">');
    expect(output).toContain('<link rel="stylesheet" href="/__braid/frag/billing/s.css">');
    expect(output).toContain('src="/__braid/frag/billing/a.js"');
    expect(output).toContain('type="inert"');
  });

  // Conformance vectors for the invariant "no markup a fragment sends can execute JavaScript in
  // the host realm, or navigate the host page". Each of these was verified *executing* in the
  // host realm before the transform existed.
  describe('no host-realm execution survives', () => {
    it('strips inline event handlers from any element', async () => {
      const output = await collect(
        prepareFragmentHtml(
          streamOf(
            `<body onload="host()"><img src=x onerror="host()"><div ONCLICK="host()">d</div>` +
              `<svg><circle onfocus='host()'/></svg><input onfocusin=host()></body>`,
          ),
          { fragmentId: 'billing' },
        ),
      );

      expect(output).not.toMatch(/\son[a-z]+\s*=/i);
      expect(output).not.toContain('host()');
      // the elements themselves survive; only the handlers are gone (the src is also
      // re-rooted into the fragment's namespace, see the subresource vectors below)
      expect(output).toContain('<img src="/__braid/frag/billing/x">');
      expect(output).toContain('<circle/>');
    });

    it('leaves framework binding syntaxes alone', async () => {
      // these are interpreted by the fragment's own framework inside its realm, so stripping
      // them would break the app without buying any isolation
      const source = `<button on-click="x" @click="y" v-on:click="z" x-on:click="w" (click)="q">b</button>`;
      const output = await collect(prepareFragmentHtml(streamOf(source), { fragmentId: 'billing' }));

      expect(output).toContain('on-click="x"');
      expect(output).toContain('@click="y"');
      expect(output).toContain('v-on:click="z"');
      expect(output).toContain('x-on:click="w"');
      expect(output).toContain('(click)="q"');
    });

    it('defangs meta refresh, which would navigate the whole host page', async () => {
      const output = await collect(
        prepareFragmentHtml(streamOf(`<head><meta http-equiv=" ReFrEsH " content="0;url=/hijacked"></head>`), {
          fragmentId: 'billing',
        }),
      );

      expect(output).not.toMatch(/http-equiv/i);
      expect(output).toContain('data-braid-blocked="meta-refresh"');
    });

    it('leaves other meta pragmas alone', async () => {
      const output = await collect(
        prepareFragmentHtml(streamOf(`<head><meta http-equiv="content-language" content="en"><meta charset="utf-8"></head>`), { fragmentId: 'billing' }),
      );

      expect(output).toContain('<meta http-equiv="content-language" content="en">');
      expect(output).toContain('<meta charset="utf-8">');
    });

    it('neutralizes every script regardless of type', async () => {
      const output = await collect(
        prepareFragmentHtml(
          streamOf(`<body><script>a()</script><script type="module">b()</script><svg><script>c()</script></svg></body>`),
          { fragmentId: 'billing' },
        ),
      );

      expect(output.match(/<script type="inert"/g)).toHaveLength(3);
      expect(output).not.toMatch(/<script>/);
    });
  });

  describe('subresource URLs', () => {
    const prepare = (html: string) =>
      collect(prepareFragmentHtml(streamOf(html), { fragmentId: 'billing' }));

    it('re-roots relative and root-absolute URLs into the fragment namespace', async () => {
      const output = await prepare(
        `<head><base href="/"><link rel="stylesheet" href="styles.css"></head>` +
          `<body><img src="/assets/logo.png"><script src="main.js"></script></body>`,
      );

      expect(output).toContain('href="/__braid/frag/billing/styles.css"');
      expect(output).toContain('src="/__braid/frag/billing/assets/logo.png"');
      expect(output).toContain('src="/__braid/frag/billing/main.js"');
    });

    it("resolves relative URLs against the fragment's own base href", async () => {
      const output = await prepare(`<head><base href="/app/"><link rel="stylesheet" href="styles.css"></head>`);

      expect(output).toContain('href="/__braid/frag/billing/app/styles.css"');
    });

    it('never rewrites the base element itself, which the fragment router reads', async () => {
      const output = await prepare(`<head><base href="/"></head>`);

      expect(output).toContain('<base href="/">');
    });

    it('leaves navigation targets alone — those belong to the host URL space', async () => {
      const output = await prepare(`<body><a href="/billing/settings">s</a><form action="/submit"></form></body>`);

      expect(output).toContain('<a href="/billing/settings">');
      expect(output).toContain('<form action="/submit">');
    });

    it('leaves cross-origin and non-http URLs alone', async () => {
      const output = await prepare(
        `<body><img src="https://cdn.example/a.png"><img src="//cdn.example/b.png">` +
          `<img src="data:image/gif;base64,R0lGOD"><use href="#icon"></use></body>`,
      );

      expect(output).toContain('src="https://cdn.example/a.png"');
      expect(output).toContain('src="//cdn.example/b.png"');
      expect(output).toContain('src="data:image/gif;base64,R0lGOD"');
      expect(output).toContain('href="#icon"');
    });

    it('rewrites each candidate in a srcset, keeping descriptors', async () => {
      const output = await prepare(`<body><img srcset="a.png 1x, b.png 2x" src="a.png"></body>`);

      expect(output).toContain('srcset="/__braid/frag/billing/a.png 1x, /__braid/frag/billing/b.png 2x"');
    });
  });

  it('does not mangle markup-like text inside scripts', async () => {
    const output = await collect(
      prepareFragmentHtml(streamOf(`<body><script>var t = "<body><script>";</script></body>`), {
        fragmentId: 'billing',
      }),
    );

    expect(output).toContain('var t = "<body><script>";');
    expect(output).toContain('<braid-body>');
  });
});

describe('pierceShellHtml()', () => {
  it('injects a declarative shadow root into the slot that names the fragment', async () => {
    const output = await collect(
      pierceShellHtml({
        shell: streamOf(`<html><head><title>Shell</title></head><body><fragment-slot name="billing"></fragment-slot></body></html>`),
        fragments: [{ fragmentId: 'billing', content: streamOf('<braid-html><braid-body>B</braid-body></braid-html>') }],
      }),
    );

    expect(output).toContain('<fragment-slot name="billing" data-braid-pierced="">');
    expect(output).toContain('<template shadowrootmode="open">');
    expect(output).toContain('<braid-document><braid-html><braid-body>B</braid-body></braid-html></braid-document>');
    expect(output).toContain('</template></fragment-slot>');
    // shell styles land in the head
    expect(output.indexOf('fragment-slot { display: block; }')).toBeLessThan(output.indexOf('<title>'));
  });

  it('ignores slots that name a different fragment', async () => {
    const output = await collect(
      pierceShellHtml({
        shell: streamOf(`<body><fragment-slot name="other"></fragment-slot><fragment-slot name="billing"></fragment-slot></body>`),
        fragments: [{ fragmentId: 'billing', content: streamOf('B') }],
      }),
    );

    expect(output).toBe(
      `<body><fragment-slot name="other"></fragment-slot>` +
        `<fragment-slot name="billing" data-braid-pierced=""><template shadowrootmode="open">` +
        `<style>:host, braid-document, braid-html, braid-body { display: block; } braid-head { display: none; }</style>` +
        `<braid-document>B</braid-document></template></fragment-slot></body>`,
    );
  });

  it('pierces several fragments into their own slots', async () => {
    const output = await collect(
      pierceShellHtml({
        shell: streamOf(`<body><fragment-slot name="a"></fragment-slot><fragment-slot name="b"></fragment-slot></body>`),
        fragments: [
          { fragmentId: 'a', content: streamOf('AAA') },
          { fragmentId: 'b', content: streamOf('BBB') },
        ],
      }),
    );

    expect(output).toContain('<braid-document>AAA</braid-document>');
    expect(output).toContain('<braid-document>BBB</braid-document>');
    expect(output.indexOf('AAA')).toBeLessThan(output.indexOf('BBB'));
  });

  it('creates a slot before </body> when the shell has none', async () => {
    const output = await collect(
      pierceShellHtml({
        shell: streamOf(`<html><body><p>shell</p></body></html>`),
        fragments: [{ fragmentId: 'billing', content: streamOf('B') }],
      }),
    );

    expect(output).toContain('<p>shell</p><fragment-slot name="billing" data-braid-pierced="">');
    expect(output).toContain('</fragment-slot></body>');
  });

  it('creates the slot at the end when the shell omits </body>', async () => {
    const output = await collect(
      pierceShellHtml({
        shell: streamOf(`<html><body><p>shell</p>`),
        fragments: [{ fragmentId: 'billing', content: streamOf('B') }],
      }),
    );

    expect(output).toContain('<p>shell</p><fragment-slot name="billing"');
    expect(output.match(/fragment-slot/g)).toHaveLength(2); // exactly one slot, open + close
  });

  it('leaves the slot empty and marks it when there is no content to pierce', async () => {
    const output = await collect(
      pierceShellHtml({
        shell: streamOf(`<body><fragment-slot name="billing"></fragment-slot></body>`),
        fragments: [{ fragmentId: 'billing', content: null, fallbackReason: 'placeholder' }],
      }),
    );

    expect(output).toBe(
      `<body><fragment-slot name="billing" data-braid-fallback="placeholder"></fragment-slot></body>`,
    );
    expect(output).not.toContain('template');
  });
});

describe('gateway piercing', () => {
  const billingApp = () =>
    htmlResponse(`<!doctype html><html><head><title>Billing</title></head><body><h1>Invoices</h1><script>go()</script></body></html>`);

  function pierceGateway(overrides: Record<string, unknown> = {}) {
    return createGateway({
      registry: [{ id: 'billing', endpoint: billingApp as unknown as typeof fetch, pierce: ['/billing/*'], ...overrides }],
    });
  }

  const documentRequest = (path: string) =>
    new Request(`https://example.com${path}`, { headers: { 'sec-fetch-dest': 'document' } });

  it('pierces a document request whose path matches the fragment pierce pattern', async () => {
    const gateway = pierceGateway();
    const shell = vi.fn(async () => htmlResponse(`<html><body><fragment-slot name="billing"></fragment-slot></body></html>`));

    const response = await gateway.handle(documentRequest('/billing/invoices'), shell);
    const body = await response!.text();

    expect(shell).toHaveBeenCalledTimes(1);
    expect(body).toContain('<template shadowrootmode="open">');
    expect(body).toContain('<h1>Invoices</h1>');
    // the fragment's script must arrive inert — it activates in the realm, never in the host
    expect(body).toContain('<script type="inert">go()</script>');
    expect(response!.headers.get('x-braid-fragment-id')).toBe('billing');
    expect(response!.headers.get('vary')).toContain('sec-fetch-dest');
  });

  it('passes through document requests that match no pierce pattern', async () => {
    const gateway = pierceGateway();
    const shell = vi.fn(async () => htmlResponse('<html><body>shell</body></html>'));

    expect(await gateway.handle(documentRequest('/somewhere-else'), shell)).toBeNull();
    expect(shell).not.toHaveBeenCalled();
  });

  it('does not pierce subresource requests', async () => {
    const gateway = pierceGateway();
    const request = new Request('https://example.com/billing/app.js', { headers: { 'sec-fetch-dest': 'script' } });

    const response = await gateway.handle(request, async () => new Response('js'));

    expect(await response!.text()).toBe('js');
    expect(response!.headers.get('x-braid-fragment-id')).toBeNull();
  });

  it('marks pierce-matching URLs as varying, even when this request is not pierced', async () => {
    // Without this, a shared cache can store the unpierced shell from a soft-navigation fetch
    // and later serve it to a real navigation — the fragment silently vanishes from the page.
    const gateway = pierceGateway();
    const softNavigation = new Request('https://example.com/billing/x', { headers: { 'sec-fetch-dest': 'empty' } });

    const response = await gateway.handle(softNavigation, async () =>
      htmlResponse('<html><body>shell</body></html>'),
    );

    expect(response!.headers.get('vary')).toContain('sec-fetch-dest');
    expect(await response!.text()).not.toContain('template');
  });

  describe('shared-cacheability of pierce-matching URLs', () => {
    // `Vary` alone does not protect these URLs: most CDNs honor it only for `Accept-Encoding`,
    // so a shared cache would store one representation and serve it as the other.
    const cacheableShell = (cacheControl: string) => async () =>
      htmlResponse('<html><body><fragment-slot name="billing"></fragment-slot></body></html>', {
        headers: { 'content-type': 'text/html;charset=utf-8', 'cache-control': cacheControl },
      });

    it('strips shared-cache directives from a composed document', async () => {
      const response = await pierceGateway().handle(
        documentRequest('/billing/invoices'),
        cacheableShell('public, max-age=600, s-maxage=3600'),
      );

      const cacheControl = response!.headers.get('cache-control')!;
      expect(cacheControl).toContain('private');
      expect(cacheControl).not.toContain('public');
      expect(cacheControl).not.toContain('s-maxage');
      // the app's own freshness lifetime is its business — only sharing is overridden
      expect(cacheControl).toContain('max-age=600');
    });

    it('marks the unpierced representation too', async () => {
      // it is the other half of the pair a cache could confuse, so it needs the same treatment
      const softNavigation = new Request('https://example.com/billing/x', {
        headers: { 'sec-fetch-dest': 'empty' },
      });

      const response = await pierceGateway().handle(softNavigation, cacheableShell('public, max-age=600'));

      expect(response!.headers.get('cache-control')).toContain('private');
    });

    it('adds nothing when the shell already said no-store', async () => {
      const response = await pierceGateway().handle(documentRequest('/billing/invoices'), cacheableShell('no-store'));

      expect(response!.headers.get('cache-control')).toBe('no-store');
    });

    it('leaves the shell untouched when the app opts out', async () => {
      const gateway = createGateway({
        registry: [{ id: 'billing', endpoint: billingApp as unknown as typeof fetch, pierce: ['/billing/*'] }],
        pierceCacheControl: 'preserve',
      });

      const response = await gateway.handle(documentRequest('/billing/invoices'), cacheableShell('public, max-age=600'));

      expect(response!.headers.get('cache-control')).toBe('public, max-age=600');
    });
  });

  it('leaves URLs that no fragment pierces completely untouched', async () => {
    const gateway = pierceGateway();
    const request = new Request('https://example.com/unrelated.js', { headers: { 'sec-fetch-dest': 'script' } });

    expect(await gateway.handle(request, async () => new Response('js'))).toBeNull();
  });

  it('returns the shell untouched when it is not html', async () => {
    const gateway = pierceGateway();
    const shell = async () => new Response('{"data":1}', { headers: { 'content-type': 'application/json' } });

    const response = await gateway.handle(documentRequest('/billing/x'), shell);

    expect(await response!.text()).toBe('{"data":1}');
  });

  it('degrades to the client-side boot path when the fragment endpoint fails', async () => {
    const gateway = createGateway({
      registry: [
        {
          id: 'billing',
          pierce: ['/billing/*'],
          endpoint: (() => Promise.reject(new Error('endpoint down'))) as unknown as typeof fetch,
        },
      ],
    });
    const shell = async () => htmlResponse(`<html><body><fragment-slot name="billing"></fragment-slot></body></html>`);

    const response = await gateway.handle(documentRequest('/billing/x'), shell);
    const body = await response!.text();

    // the page still renders, and the slot is left for the client runtime to fill —
    // a transient SSR failure self-heals rather than becoming a visible error
    expect(response!.status).toBe(200);
    expect(body).toContain('<fragment-slot name="billing" data-braid-fallback="placeholder">');
    expect(body).not.toContain('template');
  });

  it('renders error html for a failing fragment when the manifest asks for it', async () => {
    const gateway = createGateway({
      registry: [
        {
          id: 'billing',
          pierce: ['/billing/*'],
          fallback: 'error-html',
          endpoint: (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch,
        },
      ],
    });
    const shell = async () => htmlResponse(`<html><body><fragment-slot name="billing"></fragment-slot></body></html>`);

    const body = await (await gateway.handle(documentRequest('/billing/x'), shell))!.text();

    expect(body).toContain('<template shadowrootmode="open">');
    expect(body).toContain('responded with HTTP 500');
  });

  it('rejects invalid pierce patterns at registration', () => {
    expect(() =>
      createGateway({ registry: [{ id: 'x', endpoint: 'https://x.internal', pierce: ['/(unclosed'] }] }),
    ).toThrow(/invalid pierce pattern/);
  });

  it('pierces through toWebMiddleware', async () => {
    const middleware = toWebMiddleware(pierceGateway());
    const next = async () => htmlResponse(`<html><body><fragment-slot name="billing"></fragment-slot></body></html>`);

    const body = await (await middleware(documentRequest('/billing/x'), next)).text();

    expect(body).toContain('<h1>Invoices</h1>');
  });
});
