# @skewkit/braid-gateway

Fetch-native origin-front middleware. A library, not a service.

## Mounting

```ts
import { createGateway } from '@skewkit/braid-gateway';
import { toNodeMiddleware, toNodeUpgradeHandler } from '@skewkit/braid-gateway/node';

const gateway = createGateway({ registry, mode: 'production' });

app.use(toNodeMiddleware(gateway));                    // Express, NestJS, Connect, Vite
server.on('upgrade', toNodeUpgradeHandler(gateway));   // fragment websockets (dev HMR, live apps)
```

```ts
// Workers, Deno, Bun, h3/Nitro
export default toFetchHandler(gateway, toWebHandler(app));
```

Mount it **first**, so it sees requests before the app does. For a legacy app you cannot modify,
run the same library as an edge worker or reverse proxy in front of it.

## Manifests

```jsonc
{
  "id": "billing",                       // addresses the fragment; no "/" allowed
  "endpoint": "https://billing.internal", // a URL or a fetch-compatible function
  "pierce": ["/billing", "/billing/*"],   // page URLs to server-render it into
  "timeoutMs": 1500,
  "fallback": "placeholder",              // placeholder | omit | error-html
  "title": "Billing",                     // discovery metadata
  "access": { "list": {...}, "fetch": {...} }
}
```

`adapter` defaults to `compat`. An endpoint **path** is a boundary: `https://internal/apps/billing/`
cannot be used to reach the rest of that origin.

The registry is data: inline manifests, a URL to JSON, or an async loader. Deploying a fragment
never redeploys the gateway.

## The three namespaces

| Path | Serves | Notes |
| --- | --- | --- |
| `/__braid/frag/:id/*` | the fragment's endpoint (assets, data) | prefix stripped before forwarding |
| `/__braid/realm/:id/*` | the realm stub the iframe boots from | carries protocol version + adapter |
| `/__braid/doc/:id/*` | the fragment's document, prepared for the host DOM | what piercing injects |

**None of them vary on a request header** — they cache on URL alone. Only a *page* URL that a
fragment pierces varies, on `sec-fetch-dest`.

## Piercing

A document request to a `pierce`-matched URL is composed: shell and fragments fetched
concurrently, fragment HTML **stream-interleaved** into the matching `<fragment-slot>` as a
declarative shadow root. The client adopts it instead of fetching.

Fragment HTML is transformed on the way through: doctype stripped, `<html>/<head>/<body>` renamed
to `braid-*`, scripts neutralized to `type="inert"`, inline `on*` handlers stripped, meta refresh
defanged, subresource URLs re-rooted into `/__braid/frag/:id/`. `<base href>` is deliberately
left alone.

A fragment that fails to render degrades to the client-boot path rather than breaking the page.

## Access

```jsonc
"access": {
  "list":  { "roles": ["finance"] },   // who sees it in the discovery registry
  "fetch": { "scopes": ["billing:read"] } // who may load it
}
```

Both public when omitted, and independent. **Roles are any-of; scopes are all-of.** Enforced on
every namespace request, on websocket upgrades, and on piercing. Unauthorized → `403`, or `404`
when the caller may not even list it. Development mode bypasses it.

```ts
createGateway({ registry, principal: (request) => sessionFrom(request) });
```

`principal` is only called for fragments that declare `access`.

## Discovery (opt-in)

```ts
createGateway({ registry, discovery: { pageSize: 100 } });
```

`GET /__braid/registry` returns a paginated listing filtered by `access.list`, with `loadable`
per entry, endpoints withheld unless `includeEndpoints`, and `no-store`. Development mode lists
everything and says so.

## Other options

- `trustForwardedHeaders` — off by default; `x-forwarded-*` are overwritten from the real request
  unless a proxy you control is the only path in.
- `mode: 'development'` — verbose errors, bypassed access rules, and the `Origin` header rewritten
  to the endpoint's own origin so dev servers don't reject fragment module requests.
