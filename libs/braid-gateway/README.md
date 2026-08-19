# @skewkit/braid-gateway

> Every `/__braid/…` URL this package serves — what asks for it, when, and what comes back — is
> walked through in [Braid, explained](../../docs/braid-explained.md#4-the-__braid-urls).

The Braid gateway: fetch-native, platform-neutral origin-front middleware. Routes fragment
traffic by **exact id** under the reserved `/__braid/frag/:fragmentId/*` namespace — no route
pattern sniffing, no header-trust fallback — and passes everything else through to your existing
app.

Braid's founding architecture lives in [`docs/braid-architecture.md`](../../docs/braid-architecture.md).

Also see: [failure modes](../../docs/braid-failure-modes.md) ·
[CDN configuration](../../docs/braid-cdn.md) ·
[using Braid without the gateway](../../docs/braid-without-gateway.md)

## Usage

```ts
import { createGateway } from '@skewkit/braid-gateway';

const gateway = createGateway({
  registry: [
    // adapter defaults to "compat" — zero fragment code required
    { id: 'legacy-billing', endpoint: 'https://billing.internal', pierce: ['/billing/*'] },
  ],
});
```

The registry is data, not code: pass inline manifests, a URL to a JSON array of manifests,
or an async loader (file/KV/database). Deploying a fragment never redeploys the gateway.

A fragment that ships a **web component** rather than a whole app declares the adapter, the module
to load, and the element to mount:

```ts
{ id: 'rating', endpoint: 'https://widgets.example.com',
  adapter: 'custom-element', entry: '/star-rating.js', element: 'star-rating',
  events: ['rating:change'] }
```

### The registry as an FDC3 App Directory

```ts
createGateway({ registry, discovery: { appd: true } });
```

Serves the same registry in FDC3 App Directory shape at `/__braid/registry/appd/v2/apps` (and
`/appd/v2/apps/{appId}`). It is a **projection, not a second directory** — same manifests, same
`access.list` rules — so a caller can never see through AppD a resolver that discovery would have
hidden. `findIntent` becomes a registry query, and a user only sees resolvers they may use.

Manifests contribute intents through an `fdc3` block and listing metadata through `appd`:

```ts
{ id: 'billing', endpoint: '…', pierce: ['/billing/*'],
  fdc3: { listensFor: { ViewInvoice: { contexts: ['fdc3.instrument'] } },
          raises: { ViewChart: ['fdc3.instrument'] } },
  appd: { publisher: 'Payments', contactEmail: 'payments@example.com' } }
```

Two mapping decisions worth knowing:

- **`details.url` is a page, when there is one.** AppD asks where a web app lives; a fragment lives
  inside a host page. If the fragment declares `pierce`, the first concrete pattern names a page it
  actually appears on and that is the URL — follow it and you see the app. Otherwise the mount is
  used, and `hostManifests.braid.standalonePage` says which you got.
- **Braid launch detail rides in `hostManifests`**, which is what AppD reserves for exactly this.
  A fragment is *mounted into a page*, not opened as a window, so a Braid-aware agent reads
  `hostManifests.braid` and mounts a `<fragment-slot>`; one that does not falls back to the URL.

An app the caller may not list 404s exactly as an unregistered one does — distinguishing them would
let an unauthorized caller enumerate the registry one id at a time.

Verify the record shape against the FDC3 AppD v2 spec before depending on it; the schema carries
more optional members than this projects.

A relative `entry` is re-rooted into the fragment's namespace, so the module and its imports are
fetched through the gateway rather than from the host's root. Such a fragment serves no document,
and the gateway answers its document request with `204` rather than forwarding it.

## Bindings

The core is `handle(request, next)` — fetch-native and platform-neutral. Piercing needs to
*read* the shell's response, so each binding differs in how it obtains it. All three below are
covered by integration tests against the real frameworks (`bindings.spec.ts`).

**Express / Connect / Vite / plain `http`** — mount it first; `next()` runs the rest of the app,
and the gateway reads what it writes:

```ts
import { toNodeMiddleware } from '@skewkit/braid-gateway/node';

app.use(toNodeMiddleware(gateway));
```

**NestJS** — the Express adapter is a Connect stack, so the same binding applies:

```ts
const app = await NestFactory.create(AppModule);
app.use(toNodeMiddleware(gateway));
```

**Nitro / h3 / Workers / Deno / Bun** — wrap the app's fetch handler:

```ts
import { toFetchHandler } from '@skewkit/braid-gateway';
import { toWebHandler } from 'h3';

export default toFetchHandler(gateway, toWebHandler(app));
```

For a built Nitro app, the gateway also composes in front of the generated Node listener, which
needs no Nitro internals and matches the "origin-front middleware" model:

```ts
import { listener } from './.output/server/index.mjs';

const braid = toNodeMiddleware(gateway);
createServer((req, res) => braid(req, res, () => listener(req, res)));
```

A fetch-style middleware form is available too:
`toWebMiddleware(gateway)(request, () => shellResponse)`. In every binding the shell application
runs at most once per request.

## What it serves

- **Realm stubs** (`/__braid/realm/:id/*`): a minimal document carrying the composition protocol
  version, the manifest-declared adapter, and a `<base>` that keeps every relative subresource
  request inside the fragment's namespace. Version mismatches fail in the client as named errors
  — no title-check heuristics.
- **Fragment documents** (`/__braid/doc/:id/*`): the fragment's HTML prepared for the host page's
  DOM — exactly what piercing injects, for the client-boot path.
- **Fragment assets/data** (`/__braid/frag/:id/*`): forwarded to the endpoint with the prefix
  stripped, so endpoints see the same paths they serve standalone. Redirects pass through
  unfollowed; each fragment gets a manifest-declared timeout budget.
- **Pierced documents**: see below.
- **Unknown ids**: 404, never the app shell.

## Piercing

Add `pierce` patterns to a manifest and the gateway server-renders that fragment into the page:

```ts
{ id: 'legacy-billing', endpoint: 'https://billing.internal', pierce: ['/billing', '/billing/*'] }
```

On a matching document request the gateway fetches the shell and every matching fragment
concurrently, then **interleaves** the fragments into the shell's response stream — a fragment
never serializes behind the shell. Each fragment lands in the `<fragment-slot>` that names it,
as a declarative shadow root, so the browser parses it into exactly the shape the client runtime
would have built; the slot then adopts it instead of fetching. Shells with no matching slot get
one created before `</body>`.

Fragment HTML is transformed on the way through: the doctype is stripped, `<html>/<head>/<body>`
become `braid-html/braid-head/braid-body` (start *and* end tags), scripts are neutralized to
`type="inert"`, and script preload links become `rel="inert-*"`. Fragment scripts are therefore
never live in the host realm, not even between parsing and activation.

If a fragment can't be server-rendered, the page still renders and the slot is left for the
client runtime to fill — a transient SSR failure self-heals rather than becoming a visible
error. Set `fallback: 'error-html'` on the manifest when a missing section is worse than a
visible failure.

## The three namespaces

Each kind of thing the gateway serves has its own path. That is a caching decision: a URL whose
response depends on a request header needs that header in every cache key between here and the
browser, and most CDNs ignore `Vary` on anything but `Accept-Encoding`.

| Path | Serves | Cacheable |
| --- | --- | --- |
| `/__braid/frag/:id/*` | the fragment's own endpoint — assets, data, anything it serves | **yes, on URL alone** — this is nearly all the traffic |
| `/__braid/realm/:id/*` | the realm stub the fragment's hidden iframe boots from | yes, on URL alone (1h + `stale-while-revalidate`) |
| `/__braid/doc/:id/*` | the fragment's document, prepared for the host page's DOM | per the fragment's own cache headers |

**No braid URL varies on a request header.** Point a CDN at them and they cache correctly with
no configuration at all.

### The one thing that does vary

| Header | URL | Response changes to | Why |
| --- | --- | --- | --- |
| `sec-fetch-dest: document` | a page URL some fragment `pierce`s | the shell with fragments composed into it | A page navigation gets a complete document with fragments already inside. The same URL fetched by a client-side router wants the SPA's own payload, and injecting a declarative shadow root into that would corrupt it. The browser sets this header; it must reach the origin. |

Both representations carry `Vary: sec-fetch-dest` — and, because most CDNs honor `Vary` only for
`Accept-Encoding`, the gateway also rewrites `Cache-Control` on these URLs to keep them out of
shared caches: `public` and `s-maxage` are dropped, `private` is added, and your own `max-age` /
`no-store` / `stale-while-revalidate` are untouched. Browser caching still works.

Set `pierceCacheControl: 'preserve'` to opt out — only if the pages are anonymous *and* you have
put `sec-fetch-dest` into the edge's cache key. See [CDN configuration](../../docs/braid-cdn.md).

The gateway sends `Vary: sec-fetch-dest` on those page responses.

**Why `Vary` at all.** HTTP caches key on the URL. When one URL can return different bodies
depending on a request header, the cache must include that header in its key or it hands the
wrong body to the next caller. `Vary` is how the origin says which headers matter — but it is
advisory, and many CDNs honor it only for `Accept-Encoding`. Since only *page* URLs vary now,
and page URLs are usually personalized and uncacheable anyway, the practical advice is simply:
don't edge-cache pierced pages. See [CDN setup](../../docs/braid-cdn.md).

## Discovery endpoint (optional)

For shells that build their UI from the registry rather than hard-coding slot names — a launcher,
an admin console, a directory of available apps — the gateway can publish a paginated listing.
It is **off by default**, because a registry describes internal topology.

```ts
const gateway = createGateway({
  registry,
  discovery: {
    path: '/__braid/registry', // default
    pageSize: 100, // default; also the ceiling unless maxPageSize says otherwise
    principal: (request) => sessionFrom(request), // → { roles, permissions }
  },
});
```

```
GET /__braid/registry?page=2&pageSize=50
```
```json
{
  "items": [{ "id": "billing", "title": "Billing", "adapter": "compat", "mount": "/__braid/frag/billing/" }],
  "page": 2, "pageSize": 50, "total": 137, "totalPages": 3, "hasMore": true,
  "protocolVersion": "1"
}
```

**Defaults that protect you.** Internal `endpoint` values are withheld unless you set
`includeEndpoints`. Listings are `no-store` and vary on `cookie`/`authorization`, so a shared
cache can never serve one caller's listing to another. Page size is capped however large a number
the caller asks for.

**Development mode lists everything** — every fragment, with endpoints, ignoring `access` rules —
and logs a warning at startup saying so. That is deliberate for local debugging and must not ship;
the response carries `"unfiltered": true` so a client can tell.

## Access: who may list, who may load

**Everything is public by default.** A manifest with no `access` is listed for everyone and
loadable by everyone. Restrict only what needs restricting, and declare it at registration so a
fragment's own team owns its exposure rather than every host re-deciding it.

```jsonc
{
  "id": "payroll",
  "endpoint": "https://payroll.internal",
  "access": {
    "list": { "roles": ["finance", "admin"] },   // who sees it in the registry
    "fetch": { "roles": ["finance"] }            // who may actually load it
  }
}
```

The two rules are independent, which is the point:

| `list` | `fetch` | Behavior |
| --- | --- | --- |
| open | open | the default — a public fragment |
| open | restricted | shown in a launcher, refused on load; listings mark it `"loadable": false` so the UI can render that state |
| restricted | open | kept out of listings, still loadable by anyone with a deep link |
| restricted | restricted | invisible and unreachable — to that caller it does not exist |

Within a rule, **roles are any-of** (holding one of them is enough) and **scopes are all-of** (an
operation requiring two scopes needs both). Declare either or both.

Wire up who is asking once, at the gateway:

```ts
createGateway({
  registry,
  principal: (request) => sessionFrom(request), // → { roles, scopes }
  discovery: {},
});
```

`principal` is only consulted for fragments that actually declare `access`, so a public registry
never pays for a session lookup on asset requests.

**Enforcement.** `access.fetch` applies to every namespace request — the realm stub, the
document, and every asset — and to piercing, where an unauthorized fragment is simply not
composed into the page (the slot is left empty rather than the page failing). A caller who may
list but not load gets `403`; a caller who may not even list it gets `404`, because confirming
existence would turn the namespace into an inventory of what they cannot reach.

**Development mode bypasses access rules entirely**, so local work needs no session wiring.

This is authorization for *composition*, not a substitute for the fragment's own. The fragment's
endpoint should still authorize the requests it receives.

## Security posture

The trusted tier is **namespace isolation, not a security boundary**: fragments are same-origin
with the host and share its cookies, storage, and DOM reachability. What the gateway does
guarantee is that nothing a fragment sends can execute JavaScript in the *host realm* or
navigate the host page — scripts are neutralized, inline `on*` handlers are stripped, and
`<meta http-equiv="refresh">` is defanged. Fragment code runs in the fragment's realm or not at
all.

Deliberately not neutralized, because they require a user to act rather than executing on parse:
`javascript:` URLs and form `action`s. A trusted fragment can navigate a page the user clicks
through.

Defaults worth knowing: `x-forwarded-proto`/`x-forwarded-host` are **overwritten** from the real
request (opt into passthrough with `trustForwardedHeaders` only behind a proxy you control); an
endpoint's path is a boundary, so `endpoint: 'https://internal/apps/billing/'` cannot be used to
reach the rest of that origin; and every request header — including `Cookie` — is forwarded to
fragment endpoints, so treat a manifest entry as granting that endpoint the user's session.

Not yet implemented from the architecture's security section: allow-listed manifest origins and
signed manifests. Until those land, treat the registry as trusted configuration.

**The rewriter is owned, not forked.** `rewriteHtmlStream` is a small streaming HTML
rewriter with bounded memory and chunk-boundary safety; its conformance vectors
(`html-rewrite-stream.spec.ts`) are the oracle any second implementation — a native
`HTMLRewriter` path on workerd, say — must pass before it is allowed to serve traffic. Only the
owned path ships today, because `HTMLRewriter` does not exist in Node and an untested dual path
is how the upstream project got wasm/native drift.
