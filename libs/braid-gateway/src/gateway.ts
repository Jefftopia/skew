import {
  BRAID_ADAPTER_META,
  BRAID_FRAGMENT_ID_HEADER,
  BRAID_PROTOCOL_META,
  BRAID_PROTOCOL_VERSION,
  braidFragmentUrl,
  parseBraidPathname,
} from './protocol.js';
import {
  canFetch,
  canList,
  hasAccessRules,
  Principal,
  Registry,
  RegistrySource,
  ResolvedFragmentManifest,
} from './registry.js';
import { createDiscoveryHandler, DiscoveryOptions } from './discovery.js';
import { pierceShellHtml, PierceTarget, prepareFragmentHtml } from './rewriter/transforms.js';

/**
 * Gateway core (C6): fetch-native, platform-neutral origin-front middleware.
 *
 * Two responsibilities:
 *
 * 1. **Namespace routing (D4)**: requests under `/__braid/frag/:id/*` address a fragment by id,
 *    exactly — realm stubs, assets, and data. No pattern matching, no request sniffing.
 * 2. **Piercing (C7)**: for document requests whose page URL a fragment declares in its
 *    `pierce` patterns, the fragment's server-rendered HTML is interleaved into the shell's
 *    response stream, so fragments paint with the shell's first response.
 *
 * Everything else passes through to the shell untouched.
 */

export interface GatewayOptions {
  /** The fragment registry: inline manifests, a JSON URL, or an async loader (C8). */
  registry: RegistrySource;
  /** 'development' enables verbose error bodies; defaults to 'development'. */
  mode?: 'production' | 'development';
  /** Additional headers set on every request forwarded to a fragment endpoint. */
  additionalHeaders?: Record<string, string>;
  /**
   * Publishes a paginated listing of the fragments this gateway serves, for shells that build
   * their UI from the registry instead of hard-coding slot names.
   *
   * Off unless configured: a registry describes internal topology, so exposing it is a choice.
   * See {@link DiscoveryOptions}.
   */
  discovery?: DiscoveryOptions;
  /**
   * Resolves who is asking, for manifests that declare `access` rules.
   *
   * Wire it to whatever your app already uses for sessions. It is only called for fragments that
   * actually restrict something, so fully public registries never pay for it — and a fragment
   * with `access` rules but no resolver treats every caller as anonymous.
   */
  principal?: (request: Request) => Principal | undefined | Promise<Principal | undefined>;
  /**
   * Whether to pass an incoming `x-forwarded-proto` / `x-forwarded-host` through to fragment
   * endpoints instead of overwriting them from the request's own URL. Defaults to false.
   *
   * Leave it off unless a proxy you control is the only way requests reach this gateway.
   * Otherwise a client can name any host it likes, and a fragment that builds absolute URLs
   * from those headers (reset links, cache keys, redirects) will build them for the attacker's
   * host.
   */
  trustForwardedHeaders?: boolean;
}

export interface BraidGateway {
  /**
   * Handles a request if it belongs to Braid: a fragment-namespace request, or a document
   * request that pierces one or more fragments. Returns null for everything else — the caller
   * passes those through to the shell.
   *
   * @param next fetches the shell application's response. Required for piercing; without it,
   *             document requests are passed through and fragments boot client-side instead.
   */
  handle(request: Request, next?: () => Promise<Response>): Promise<Response | null>;

  /**
   * Resolves a websocket upgrade addressed to a fragment.
   *
   * Dev servers push reloads over websockets, and live apps use them for real work. Both are
   * addressed through the fragment namespace, so the gateway has to say where they go — the
   * socket plumbing itself belongs to the platform binding.
   *
   * @returns the endpoint URL to dial, or null when the request is not a fragment upgrade, the
   *          fragment is unknown, or the caller may not load it.
   */
  resolveUpgrade(request: Request): Promise<{ fragmentId: string; target: URL } | null>;
}

export function createGateway(options: GatewayOptions): BraidGateway {
  const registry = new Registry(options.registry);
  const mode = options.mode ?? 'development';
  const additionalHeaders = options.additionalHeaders ?? {};
  const trustForwardedHeaders = options.trustForwardedHeaders ?? false;
  const isDevelopment = mode === 'development';

  /**
   * Resolves the caller, but only when some manifest actually restricts something — a fully
   * public registry never pays for session lookup on every asset request.
   */
  const resolvePrincipal = async (request: Request): Promise<Principal | undefined> =>
    options.principal ? ((await options.principal(request)) ?? undefined) : undefined;

  const discovery = createDiscoveryHandler(registry, options.discovery, mode, resolvePrincipal);

  return {
    async handle(request: Request, next?: () => Promise<Response>): Promise<Response | null> {
      const requestUrl = new URL(request.url);

      if (discovery && requestUrl.pathname === discovery.path) {
        return discovery.handle(request, requestUrl);
      }

      const route = parseBraidPathname(requestUrl.pathname);

      if (!route) {
        return next ? handleShellRequest(request, requestUrl, next) : null;
      }

      /**
       * Braid requests are routed to the addressed fragment exactly: an unknown fragment id is a
       * 404 (never the app shell, and never a header-based fallback — removed by design).
       */
      const fragment = await registry.getFragment(route.fragmentId);

      if (!fragment) {
        // no protocol meta on purpose: the client's stub verification fails loudly with a named
        // error instead of silently reframing this error document
        return htmlResponse(
          `<!doctype html><title>Braid: unknown fragment</title>` +
            (mode === 'development'
              ? `<p>braid-gateway: no fragment with id "${escapeHtml(route.fragmentId)}" is registered.<br>` +
                `Register a manifest for it in the gateway registry, and ensure @skewkit/braid and @skewkit/braid-gateway versions match.</p>`
              : '<p>Unknown fragment</p>'),
          404,
        );
      }

      // a fragment may declare who is allowed to load it at all (public unless it says otherwise)
      const denied = await authorizeFetch(request, fragment);
      if (denied) return denied;

      switch (route.kind) {
        /**
         * The realm stub: the document the fragment's hidden iframe boots from. It exists so the
         * realm has a real same-origin URL, which is what lets the client `replaceState` it to
         * the fragment's route and make `location`/`history` truthful.
         *
         * Its `<base>` points into the *fragment* namespace, so relative subresource requests
         * made from the fragment's JS context resolve to the fragment's own assets even after
         * the route-url illusion is restored.
         */
        case 'realm':
          return htmlResponse(
            `<!doctype html><title>Braid realm</title>` +
              `<meta name="${BRAID_PROTOCOL_META}" content="${BRAID_PROTOCOL_VERSION}">` +
              `<meta name="${BRAID_ADAPTER_META}" content="${escapeHtml(fragment.adapter)}">` +
              `<base href="${escapeHtml(braidFragmentUrl(fragment.id, route.pathname))}">`,
            200,
            {
              [BRAID_FRAGMENT_ID_HEADER]: fragment.id,
              // identical for a given url, and now varies on nothing: safe to cache anywhere
              'Cache-Control': 'max-age=3600, public, stale-while-revalidate=31536000',
            },
          );

        /**
         * The fragment's document, prepared for the host page's DOM: singletons renamed, scripts
         * neutralized, subresource URLs re-rooted into the fragment namespace. Exactly what
         * piercing injects, for the client-boot path.
         */
        case 'document':
          return forwardToFragment(request, requestUrl, route.pathname, fragment, { prepare: true });

        /**
         * The fragment's own endpoint — assets, data, anything it serves — forwarded with the
         * prefix stripped so the endpoint sees the paths it would serve standalone.
         */
        case 'fragment':
          return forwardToFragment(request, requestUrl, route.pathname, fragment);
      }
    },

    async resolveUpgrade(request: Request): Promise<{ fragmentId: string; target: URL } | null> {
      const requestUrl = new URL(request.url);
      const route = parseBraidPathname(requestUrl.pathname);

      // only the fragment namespace carries live sockets; stubs and documents are plain GETs
      if (!route || route.kind !== 'fragment') return null;

      const fragment = await registry.getFragment(route.fragmentId);
      if (!fragment) return null;

      // a socket is a load like any other, so the same access rule applies
      if (await authorizeFetch(request, fragment)) return null;

      // a fetcher-function endpoint has no origin to dial
      if (typeof fragment.endpoint !== 'string') return null;

      const strippedUrl = new URL(requestUrl);
      strippedUrl.pathname = route.pathname;

      try {
        return { fragmentId: fragment.id, target: resolveEndpointUrl(fragment.endpoint, strippedUrl, fragment.id) };
      } catch {
        return null;
      }
    },
  };

  /**
   * Applies a fragment's `access.fetch` rule, if it declares one.
   *
   * A caller who may not even *list* the fragment gets a 404: to them it does not exist, and
   * saying otherwise would turn the namespace into an inventory of what they cannot reach. A
   * caller who may list it but not load it gets an honest 403.
   *
   * Both rules are public by default, so a registry that declares no `access` never lands here.
   */
  async function authorizeFetch(
    request: Request,
    fragment: ResolvedFragmentManifest,
  ): Promise<Response | null> {
    if (isDevelopment || !hasAccessRules(fragment)) return null;

    const principal = await resolvePrincipal(request);
    if (canFetch(fragment, principal)) return null;

    if (!canList(fragment, principal)) {
      return htmlResponse(
        `<!doctype html><title>Braid: unknown fragment</title><p>Unknown fragment</p>`,
        404,
      );
    }

    return htmlResponse(
      `<!doctype html><title>Braid: forbidden</title><p>You do not have access to this fragment.</p>`,
      403,
      { [BRAID_FRAGMENT_ID_HEADER]: fragment.id },
    );
  }

  async function forwardToFragment(
    request: Request,
    requestUrl: URL,
    strippedPathname: string,
    fragment: ResolvedFragmentManifest,
    options: { prepare?: boolean } = {},
  ): Promise<Response> {
    const result = await fetchFragment(request, requestUrl, strippedPathname, fragment);

    if (!result.ok && result.outOfScope) {
      console.warn(String(result.error));
      return htmlResponse(
        mode === 'development'
          ? `<p>braid-gateway: that path is outside the endpoint declared by fragment "${escapeHtml(fragment.id)}".</p>`
          : '<p>Not found</p>',
        404,
        { [BRAID_FRAGMENT_ID_HEADER]: fragment.id },
      );
    }

    if (!result.ok) {
      return htmlResponse(
        mode === 'development'
          ? `<p>braid-gateway: ${describeFragmentFailure(fragment, result)}.<br>` +
              `Endpoint: ${escapeHtml(describeEndpoint(fragment))}<br>` +
              `Error: ${escapeHtml(String(result.error))}</p>`
          : '<p>There was a problem fulfilling your request.</p>',
        result.timedOut ? 504 : 502,
        { [BRAID_FRAGMENT_ID_HEADER]: fragment.id },
      );
    }

    /**
     * A fragment *document* gets exactly the preparation pierced content gets. Without it the
     * same fragment would behave differently depending on whether it was server-rendered into
     * the page or fetched by the slot — its relative asset URLs would resolve against the host
     * page, and its scripts would arrive live in the host realm.
     */
    const prepare =
      options.prepare && result.response.headers.get('content-type')?.toLowerCase().includes('text/html');

    const body =
      prepare && result.response.body
        ? prepareFragmentHtml(result.response.body, { fragmentId: fragment.id })
        : result.response.body;

    const forwarded = new Response(body, result.response);
    forwarded.headers.append(BRAID_FRAGMENT_ID_HEADER, fragment.id);
    if (prepare) {
      // the body was transformed, so any length the endpoint declared no longer describes it
      forwarded.headers.delete('content-length');
    }
    return forwarded;
  }

  type FragmentFetchResult =
    | { ok: true; response: Response }
    | { ok: false; error: unknown; timedOut: boolean; outOfScope?: boolean };

  /**
   * Fetches from a fragment's endpoint. The namespace prefix is already stripped, so the
   * endpoint sees the same path it would serve standalone.
   */
  async function fetchFragment(
    request: Request,
    requestUrl: URL,
    pathname: string,
    fragment: ResolvedFragmentManifest,
  ): Promise<FragmentFetchResult> {
    const { endpoint } = fragment;

    const strippedUrl = new URL(requestUrl);
    strippedUrl.pathname = pathname;

    let fragmentRequestUrl: URL;
    let fragmentFetch: typeof fetch;

    if (typeof endpoint === 'function') {
      fragmentRequestUrl = strippedUrl;
      fragmentFetch = endpoint;
    } else {
      try {
        fragmentRequestUrl = resolveEndpointUrl(endpoint, strippedUrl, fragment.id);
      } catch (error) {
        return { ok: false, error, timedOut: false, outOfScope: error instanceof EndpointScopeError };
      }
      fragmentFetch = globalThis.fetch;
    }

    const fragmentRequest = new Request(fragmentRequestUrl, request);

    // Tell the fragment endpoint the protocol and host the *user* reached us on.
    //
    // These are overwritten, not forwarded: an incoming x-forwarded-host is client-controlled,
    // and fragments routinely build absolute URLs from it. Set `trustForwardedHeaders` only
    // when a proxy you control is the sole path to this gateway.
    fragmentRequest.headers.set(
      'x-forwarded-proto',
      (trustForwardedHeaders && request.headers.get('x-forwarded-proto')) || requestUrl.protocol.slice(0, -1),
    );
    fragmentRequest.headers.set(
      'x-forwarded-host',
      (trustForwardedHeaders && request.headers.get('x-forwarded-host')) || requestUrl.host,
    );

    for (const [name, value] of Object.entries(additionalHeaders)) {
      fragmentRequest.headers.set(name, value);
    }

    // the endpoint serves an embedded fragment, not a full document
    fragmentRequest.headers.set('sec-fetch-dest', 'empty');
    fragmentRequest.headers.set('x-braid-fragment-mode', 'embedded');

    /**
     * In development, present the request as coming from the endpoint's own origin.
     *
     * Module scripts are fetched in CORS mode, so the browser attaches the *host page's* origin
     * to every one of a fragment's script requests. Dev servers (Vite, and anything else with
     * cross-origin request protection) reject those with a 403, which shows up as a fragment
     * that boots but renders nothing. The gateway is the origin-front here, so rewriting the
     * header is truthful: from the endpoint's perspective the request did come from its origin.
     *
     * Not done in production, where an endpoint may legitimately want the real origin.
     */
    if (isDevelopment && typeof endpoint === 'string') {
      fragmentRequest.headers.set('origin', new URL(endpoint).origin);
      fragmentRequest.headers.delete('referer');
    }

    // a document request carries validators for the *shell*; they mean nothing to the fragment
    fragmentRequest.headers.delete('if-none-match');
    fragmentRequest.headers.delete('if-modified-since');

    // per-fragment timeout budget from the manifest
    const timeoutSignal = AbortSignal.timeout(fragment.timeoutMs);

    try {
      // don't follow redirects: they are sent all the way to the client, which can then decide
      // to follow them or not (this keeps window.location correct in the fragment's realm)
      const response = await fragmentFetch(fragmentRequest, { redirect: 'manual', signal: timeoutSignal });
      return { ok: true, response };
    } catch (error) {
      return { ok: false, error, timedOut: timeoutSignal.aborted };
    }
  }

  /**
   * Handles a request bound for the shell application.
   *
   * A document navigation to a URL some fragment declares in `pierce` is composed. Any *other*
   * request to such a URL is passed through — but still gets `vary: sec-fetch-dest`, because
   * the same URL now has two representations. Without it a shared cache can store the
   * unpierced shell from a soft-navigation fetch and later serve it to a real navigation,
   * silently dropping the fragment from the page.
   */
  async function handleShellRequest(
    request: Request,
    requestUrl: URL,
    next: () => Promise<Response>,
  ): Promise<Response | null> {
    if (request.method !== 'GET') return null;

    const matches = await registry.matchPierceRoutes(requestUrl.pathname);
    if (matches.length === 0) return null;

    if (isDocumentRequest(request)) {
      // a fragment the caller may not load is simply not composed into their page; the slot is
      // left for the client, which will get the same 403/404 and can render it as it sees fit
      const permitted: ResolvedFragmentManifest[] = [];
      for (const fragment of matches) {
        if (!(await authorizeFetch(request, fragment))) permitted.push(fragment);
      }

      if (permitted.length > 0) {
        return pierceDocument(request, requestUrl, next, permitted);
      }
    }

    const shell = await next();
    const passthrough = new Response(shell.body, shell);
    passthrough.headers.append('vary', 'sec-fetch-dest');
    return passthrough;
  }

  /**
   * Composes a document response: the shell, with every fragment that declares this page URL
   * pierced into the slot that names it (C7).
   *
   * The shell and all matching fragments are fetched concurrently, and the fragments' HTML is
   * interleaved into the shell's stream as it arrives — so a fragment never serializes behind
   * the shell, and the page paints with fragments already present.
   */
  async function pierceDocument(
    request: Request,
    requestUrl: URL,
    next: () => Promise<Response>,
    matches: ResolvedFragmentManifest[],
  ): Promise<Response | null> {
    const pagePath = `${requestUrl.pathname}${requestUrl.search}`;
    const [shellResponse, ...fragmentResults] = await Promise.all([
      next(),
      // bound fragments render the page's own route, so the endpoint gets the page path
      ...matches.map((fragment) => fetchFragment(request, requestUrl, requestUrl.pathname, fragment)),
    ]);

    const shell = new Response(shellResponse.body, shellResponse);
    shell.headers.append('vary', 'sec-fetch-dest');

    const isHtml = shell.headers.get('content-type')?.toLowerCase().includes('text/html');

    if (!shell.ok || !isHtml || !shell.body) {
      // nothing to pierce into: hand the shell back untouched and cancel the fragment bodies
      await Promise.all(
        fragmentResults.map((result) => (result.ok ? result.response.body?.cancel() : undefined)),
      );
      return shell;
    }

    const targets: PierceTarget[] = matches.map((fragment, index) => {
      const result = fragmentResults[index];
      const failed = !result.ok || !result.response.ok || !result.response.body;

      if (!failed) {
        return {
          fragmentId: fragment.id,
          content: prepareFragmentHtml(result.response.body!, { fragmentId: fragment.id }),
        };
      }

      const detail = !result.ok
        ? describeFragmentFailure(fragment, result)
        : `fragment "${fragment.id}" responded with HTTP ${result.response.status}`;
      console.warn(`braid-gateway: not piercing ${pagePath} — ${detail}`);

      if (result.ok) void result.response.body?.cancel();

      // `error-html` is the only fallback that renders something; `omit` and `placeholder`
      // leave the slot empty, and the client runtime fetches the fragment itself — a failed
      // pierce degrades to the client-side boot path rather than to a broken page
      if (fragment.fallback === 'error-html') {
        return {
          fragmentId: fragment.id,
          content: stringStream(
            mode === 'development'
              ? `<braid-html><braid-body><p>braid-gateway: ${escapeHtml(detail)}</p></braid-body></braid-html>`
              : '<braid-html><braid-body><p>This section is temporarily unavailable.</p></braid-body></braid-html>',
          ),
        };
      }

      return {
        fragmentId: fragment.id,
        content: null,
        ...(fragment.fallback === 'placeholder' ? { fallbackReason: 'placeholder' } : {}),
      };
    });

    const pierced = new Response(pierceShellHtml({ shell: shell.body, fragments: targets }), shell);
    // the body is transformed, so any length/encoding the shell declared no longer describes it
    pierced.headers.delete('content-length');
    pierced.headers.delete('content-encoding');
    for (const target of targets) {
      pierced.headers.append(BRAID_FRAGMENT_ID_HEADER, target.fragmentId);
    }
    return pierced;
  }

  function describeFragmentFailure(
    fragment: ResolvedFragmentManifest,
    result: { timedOut: boolean },
  ): string {
    return result.timedOut
      ? `fragment "${fragment.id}" exceeded its ${fragment.timeoutMs}ms timeout budget`
      : `fetching fragment "${fragment.id}" failed`;
  }

  function describeEndpoint(fragment: ResolvedFragmentManifest): string {
    return typeof fragment.endpoint === 'function' ? '[fetcher function]' : String(fragment.endpoint);
  }

  /**
   * A gateway-authored response inside a braid namespace.
   *
   * No `Vary` here: since realm stubs and prepared documents have their own paths, every braid
   * URL has exactly one representation and caches on URL alone.
   */
  function htmlResponse(body: string, status: number, headers: Record<string, string> = {}): Response {
    return new Response(body, {
      status,
      headers: {
        'Content-Type': 'text/html;charset=UTF-8',
        ...headers,
      },
    });
  }
}

/**
 * Wraps a gateway as web middleware: braid requests are handled — including document requests
 * that pierce fragments into the shell — and everything else goes to the shell via `next()`.
 *
 * `next` is memoized, so the shell application runs at most once per request no matter how the
 * gateway and the caller interleave.
 */
export function toWebMiddleware(
  gateway: BraidGateway,
): (request: Request, next: () => Promise<Response>) => Promise<Response> {
  return async (request, next) => {
    const shellOnce = once(next);
    return (await gateway.handle(request, shellOnce)) ?? shellOnce();
  };
}

/**
 * Wraps a fetch handler — the shell application as `(Request) => Response` — with the gateway.
 *
 * This is the binding for every web-standard runtime: Cloudflare Workers, Deno, Bun, and
 * h3/Nitro (via `toWebHandler(app)`). It is also the only in-process way to pierce on those
 * runtimes, because piercing needs to *read* the shell's response, which a middleware chain
 * with no return value cannot give it.
 *
 * ```ts
 * // h3 / Nitro
 * import { toWebHandler } from 'h3';
 * export default toFetchHandler(gateway, toWebHandler(app));
 * ```
 */
export function toFetchHandler(
  gateway: BraidGateway,
  appHandler: (request: Request) => Response | Promise<Response>,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const shellOnce = once(() => Promise.resolve(appHandler(request)));
    return (await gateway.handle(request, shellOnce)) ?? shellOnce();
  };
}

/** Memoizes an async thunk so the wrapped work happens at most once. */
function once(fn: () => Promise<Response>): () => Promise<Response> {
  let pending: Promise<Response> | undefined;
  return () => (pending ??= fn());
}

/**
 * Whether a request is a top-level document navigation, which is what piercing composes.
 *
 * `sec-fetch-dest` is the reliable signal in browsers; the `accept` heuristic covers clients
 * that don't send fetch metadata (curl, some proxies, tests).
 */
function isDocumentRequest(request: Request): boolean {
  if (request.method !== 'GET') return false;

  const destination = request.headers.get('sec-fetch-dest');
  if (destination) return destination === 'document';

  return request.headers.get('accept')?.includes('text/html') ?? false;
}

/**
 * Resolves a namespace-stripped request against a fragment's endpoint, **within the endpoint's
 * own path**.
 *
 * `new URL('/admin', 'https://internal/apps/billing/')` yields `https://internal/admin`: an
 * absolute path replaces the endpoint's path entirely. Left alone, that turns the gateway into
 * a proxy for the endpoint host's whole origin rather than the subtree the manifest declared.
 * So the endpoint's path is treated as a prefix.
 *
 * The containment check afterwards is belt-and-braces: dot segments, including percent-encoded
 * ones (`%2e%2e`), are already normalized when the incoming request URL is parsed, which takes
 * such a request out of the fragment namespace entirely before it ever reaches here. The check
 * costs nothing and does not assume every runtime normalizes identically.
 */
export function resolveEndpointUrl(endpoint: string, strippedUrl: URL, fragmentId: string): URL {
  const endpointUrl = new URL(endpoint);
  const basePath = endpointUrl.pathname.endsWith('/') ? endpointUrl.pathname.slice(0, -1) : endpointUrl.pathname;

  const resolved = new URL(`${basePath}${strippedUrl.pathname}${strippedUrl.search}`, endpointUrl.origin);

  if (basePath && resolved.pathname !== basePath && !resolved.pathname.startsWith(`${basePath}/`)) {
    throw new EndpointScopeError(
      `braid-gateway: a request for fragment "${fragmentId}" resolved to "${resolved.pathname}", outside its ` +
        `endpoint path "${basePath}/" — refusing to forward it`,
    );
  }

  return resolved;
}

/** Thrown when a namespace request would reach outside its fragment endpoint's declared path. */
class EndpointScopeError extends Error {}

function stringStream(content: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(content));
      controller.close();
    },
  });
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
