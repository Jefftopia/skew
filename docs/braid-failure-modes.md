# Braid — failure modes and how to avoid them

> Symptom-first, and it assumes you know what a realm, a slot, and the `/__braid/` namespace are.
> If a term here is unfamiliar, [**Braid, explained**](braid-explained.md) defines it in one page.

Composition failures are rarely loud. A fragment that quietly re-fetches content it already had,
or lags one navigation behind, looks like it works. This is the catalogue of the ones we have
actually hit, each with the symptom you would see first and the thing that prevents it.

Every entry here was observed in a real browser during development, not imagined.

---

## A routed fragment mounted by client-side navigation hijacks the host URL

**Symptom.** The host router navigates to a route — say `/reports` — and the URL immediately becomes
one of the *fragment's* routes instead. The page renders the wrong component. A direct load or a
full reload of the same URL works perfectly.

**Trace.** Instrumenting `history` on the host shows the host's own navigation succeeding and then
being undone by a traversal nobody in the host called:

```
pushState /reports   → /reports
POPSTATE             → /billing/invoices
replaceState /billing/invoices
```

No `history.back()`, `forward()`, or `go()` runs in the top document. The traversal comes from
**inside a realm**: a compat realm is a real same-origin iframe on a real URL, so its navigations
join the top document's session history, and a traversal there moves the top document with it.

**Cause.** A compat fragment whose own application has a router, mounted onto a route reached by
*client-side* navigation. When the realm boots, the fragment's router performs its initial
navigation; that navigation lands in the joint session history alongside the host's just-pushed
entry, and the resulting traversal replaces it.

Setting `src` does **not** avoid it. An unbound fragment does not *drive* host navigation through
Braid, but its realm is still an iframe in the same session history, which is a lower level than
`bound` operates at.

**What it does not affect.** A fragment with no router of its own — a React app without one, a
custom element — is fine, because nothing inside it navigates on boot. Pages reached by a full
document load are fine, because the host is not mid-`pushState` when the realms boot. That is why
the composed billing page works and a client-side hop to another page mounting the same fragment
does not.

**Workarounds today.**

| | |
| --- | --- |
| Reach the page by document load | correct but defeats client-side routing |
| Mount routed fragments only on routes they own | what the POC does; the composed page is entered directly |
| Use a fragment without its own router on such pages | what the demo page does |

**The real fix is the `contract-blob` realm kind**, which boots from a runtime-authored `blob:` URL
and has *zero* interaction with the joint session history — the realm manager already says this
eliminates "the whole class of back/forward corruption that http-booted realms have to work
around". This is a concrete instance of that class. Contract-blob realms exist and are tested, but
only contract-mode fragments can use them, because compat mode needs a real `http:` URL to make
`location`/`history` truthful.

So the honest statement of the limitation: **compat mode buys zero app changes and pays for it in
session-history fidelity.** A routed compat fragment is safe on the routes it owns, and unsafe as a
passenger on someone else's client-side navigation.

## Host integration

### The fragment renders, then flickers and re-renders — and there are two realms

**Symptom.** `document.querySelectorAll('iframe[name^="braid:"]')` returns more than one frame
per slot. The network shows the fragment's HTML being fetched even though the gateway pierced it
into the page.

**Cause.** The host framework discarded the server-rendered DOM and re-created it. Angular does
this when hydration is not enabled: `<fragment-slot>` is destroyed along with the shadow root the
gateway filled, and the new element boots a second realm to fetch the fragment itself.

**Prevention.** Enable hydration on **both** bootstraps — the server has to emit the annotations
for the client to reuse them. Configuring it on only one side silently does nothing:

```ts
// shared app config, used by main.ts and main.server.ts
providers: [provideClientHydration()];
```

**Check it.** One realm per slot, and `slot.hasAttribute('data-braid-pierced')` is true.

### The fragment lags one navigation behind the host

**Symptom.** Clicking a host link changes the URL and the host's own UI, but the fragment still
shows the previous screen. Back/forward works correctly, which makes it look intermittent.

**Cause.** `onHostNavigation` was wired to *every* router event. Routers report navigation in
phases, and the early ones fire before the URL changes — Angular's `NavigationStart` is the
common case — so the fragment is told about a location the page has not reached yet.

**Prevention.** Wire an *after*-navigation hook only:

```ts
router.events
  .pipe(filter((e) => e instanceof NavigationEnd || e instanceof NavigationSkipped))
  .subscribe(() => notify());
```

The navigation bus also defends against this (it keys duplicate-suppression on the URL rather
than on time alone), but the filtered wiring is what you should write.

### `<fragment-slot>` renders nothing and the console has no Braid errors

**Cause.** `initBraid()` was never called, so the custom element was never defined and the
element is an inert unknown tag.

**Prevention.** Call `initBraid()` once during bootstrap, before any slot connects. If it runs
but an adapter is missing you get a named `adapter-resolution` error instead of silence.

### The framework complains about an unknown element

**Prevention.** Angular needs `CUSTOM_ELEMENTS_SCHEMA` on the component that renders the slot.
Vue needs `compilerOptions.isCustomElement`. React needs nothing.

---

## Fragment (remote app) integration

### The fragment's stylesheet 404s, or the wrong CSS loads

**Symptom.** Unstyled fragment content; a request for `/some/host/path/styles.css`.

**Cause.** A fragment's markup lives in the *host* page's DOM, so its relative URLs resolve
against the host page. The gateway re-roots subresource URLs into `/__braid/frag/:id/…` to
prevent exactly this — if you are seeing it, the response did not go through that transform.

**Prevention.** Fetch fragment documents through `/__braid/doc/:id/…`, which is the namespace
that returns markup already prepared for the host's DOM. The client does this automatically;
fetching `/__braid/frag/:id/…` instead gives you the fragment's raw HTML, which is not safe to
insert.

### A widget renders an empty shell, or 404s, on every page

**Symptom.** A fragment meant to appear everywhere pierces nothing. The slot carries
`data-braid-fallback="placeholder"`, or the fragment's endpoint logs a stream of 404s for paths that
belong to the host — `/billing/invoices`, `/settings`, `/`.

**Cause.** The fragment is **bound** when it should not be. A bound fragment is a screen: the
gateway fetches it at the page's own path, because that is the route it is supposed to render.
Chrome — a header panel, a sidebar, a global search box — has content at one fixed address instead,
and asking its endpoint for the host's path is a question it has no answer to.

**Fix.** Declare it unbound, and say where its content lives:

```jsonc
{ "id": "notifications", "bound": false, "src": "/panel", "pierce": ["/", "/*"] }
```

The gateway warns at registration when `bound: false` arrives without a `src`, because the fallback
behaviour — fetching the page path — is wrong in a way that shows up as an empty widget rather than
as an error anyone can trace.

### The widget changes the moment it hydrates

**Symptom.** The server-rendered widget is right in the first paint, then flips to different content
(or to an empty state) as soon as the client boots.

**Cause.** The slot's `src` and the manifest's `src` disagree. The gateway pierced content from one
path; the client runtime then booted the fragment at the other. Both are working correctly — they
were told different things.

**Fix.** Make them agree. The gateway prints
`slot for fragment "…" declares src="…" but its manifest declares src="…"` at pierce time, which is
the only place this is visible before a user reports it. A slot that declares no `src` at all is
filled in from the manifest, so omitting it is safer than guessing at it.

### The fragment's own router computes the wrong routes

**Cause.** Something rewrote the fragment's `<base href>`. The fragment's router reads it to
learn its base path, and pointing it at the namespace makes every route resolve under
`/__braid/frag/…`, which the host URL never matches.

**Prevention.** Leave `<base>` alone — the gateway deliberately never rewrites it. Build the
remote with its normal base href (usually `/`), not with the namespace baked in.

### The fragment's JavaScript never runs

**Symptom.** Content appears (the SSR markup) but nothing is interactive; possibly
`Failed to load module script … MIME type "text/html"`.

**Causes, in order of likelihood.** The fragment endpoint has no SPA history fallback, so a
namespaced path returns HTML instead of the asset. Or the fragment's HTML was inserted without
being prepared, leaving relative script URLs to resolve against the realm's route directory.

**Prevention.** Serve the fragment endpoint with a history fallback, and let the gateway prepare
every fragment document. A fragment's scripts always execute in its realm — never in the host —
so a script that "does nothing" is usually a URL problem, not an execution problem.

### The realm fails to boot with a named `realm-boot` error

**Causes.** The gateway is not mounted in front of the app (the stub request returned the host's
own HTML); the client and gateway package versions disagree on the protocol; or the fragment
endpoint sets `X-Frame-Options: DENY`, which stops the realm iframe loading.

**Prevention.** Mount the gateway first in the middleware chain, upgrade `@skewkit/braid` and
`@skewkit/braid-gateway` together, and do not let a CDN or WAF inject frame-blocking headers on
namespace responses. The error message names which of these it is.

---

## Deployment and build

### The browser runs an old client bundle after a rebuild

**Symptom.** Changes to the host or fragment have no effect; behavior matches a previous build.

**Cause.** Unhashed filenames served with a long `max-age`. Development builds often disable
filename hashing while the server still sends year-long cache headers.

**Prevention.** Use `outputHashing` in every configuration you actually serve, or send
`max-age=0` for unhashed assets. Do not rely on a manual hard-reload — your users cannot do one.

### Two dev servers answer on the same port

**Symptom.** One app's content served under the other's URL; a fragment that "is" the whole page.

**Cause.** Multiple child processes inheriting `PORT` from whatever launched them. The second one
fails to bind and the survivor answers for both.

**Prevention.** Pass each server its port explicitly rather than inheriting it, and fail loudly
when a child exits non-zero.

### A fragment disappears on some page loads

**Cause.** A shared cache served a composed page to a request that wanted the plain shell, or the
reverse. A page URL that a fragment pierces is the only Braid URL with more than one
representation — see [the three namespaces](../libs/braid-gateway/README.md#the-three-namespaces).

**Prevention.** Don't edge-cache pierced pages — the gateway defends this by default, marking
them `private` so a correct shared cache will not store them. Seeing this failure anyway means
either something at the edge is rewriting `Cache-Control`, or you set
`pierceCacheControl: 'preserve'`, in which case `sec-fetch-dest` must be in the cache key for
those routes and nothing at the edge may strip it. Braid URLs themselves
(`/__braid/frag|realm|doc/*`) vary on nothing and need no configuration.

---

## Security-shaped surprises

### Fragment code runs in the host's JavaScript context

This should not happen: the gateway strips inline `on*` handlers, neutralizes every `<script>`,
and defangs `<meta http-equiv="refresh">`, so no markup a fragment sends can execute in the host
realm or navigate the host page.

**What is still yours to own.** `javascript:` URLs and form `action`s are not neutralized because
they require a user to act, and a trusted fragment is allowed to navigate a page the user clicks
through. And the trusted tier is *namespace isolation, not a security boundary*: fragments are
same-origin and share the host's cookies and storage. Treat a manifest entry as granting that
endpoint the user's session.

### A fragment endpoint reaches further than its manifest says

**Prevention.** Give the endpoint a path (`https://internal/apps/billing/`) and the gateway
treats it as a boundary; requests that would resolve outside it are refused. Leave
`trustForwardedHeaders` off unless a proxy you control is the only route to the gateway.

---

## Quick diagnostic

Run this in the console on a page with a fragment. It answers most of the above at once:

```js
const slot = document.querySelector('fragment-slot');
({
  state: slot.state,
  pierced: slot.hasAttribute('data-braid-pierced'),
  realms: document.querySelectorAll('iframe[name^="braid:"]').length, // expect 1 per slot
  hostPrototypesPristine: Node.prototype.appendChild.toString().includes('[native code]'),
  hostHistoryPristine: !Object.getOwnPropertyDescriptor(window.history, 'pushState'),
});
```

`initBraid({ dev: true })` adds boot timings, unaudited-API warnings from the compat document
facade, and reports of nodes entering the fragment through paths the boundary cannot intercept
synchronously.
