---
name: using-braid
description: >-
  How to correctly use the Braid packages (@braid/core, @braid/gateway,
  @braid/angular, @braid/react, @braid/cli) to compose independently deployed frontend
  applications into one page. Use this skill whenever a task involves micro-frontends,
  composing or embedding one web application inside another, <fragment-slot> or
  <braid-fragment>, the /__braid/ URL namespaces, server-side piercing, fragment realms,
  the compat adapter, a gateway in front of an app, module federation migration, or
  "we need team B's app to show up inside team A's page" — even if the user never says
  the word "Braid". Also use it when a composed fragment renders but does not boot,
  boots twice, lags a navigation behind, loses its styles, or disappears intermittently,
  since each of those has a specific known cause.
---

# Using Braid

Braid composes independently deployed frontend apps into one page: one origin, one DOM, one
accessibility tree, while each app keeps its own JavaScript world, dependencies, and release
train. A *fragment* is one such app; a *host* (or shell) is the page it appears in.

Two things make it work, and most mistakes come from misunderstanding one of them:

1. **A fragment's code runs in its own realm** — a hidden same-origin iframe — while its DOM
   lives in the host page inside a shadow root. The fragment believes it owns the browser.
2. **A gateway sits in front of the host origin.** It routes fragment traffic by exact id and
   composes fragment HTML into the shell's server-rendered response.

## Decide what you are doing

| Situation | Do this |
| --- | --- |
| Add an existing app into another page | compat adapter (the default) — no changes to the fragment |
| Compose a fragment that *is* a web component | `custom-element` adapter: manifest `entry` + `element` |
| Host a fragment in an Angular app | `@braid/angular`: `provideBraid()` + `<braid-fragment>` |
| Host a fragment in a React app | `@braid/react`: `initBraidReact()` + `<BraidFragment>` |
| Host a fragment in anything else | `initBraid()` + `<fragment-slot name="…">` |
| Put a gateway in front of an app | `createGateway()` + a binding (`toNodeMiddleware`, `toFetchHandler`) |
| Run it all locally | `braid dev` from `@braid/cli` |

## The rules that matter

**The gateway is required for compat fragments.** It serves the realm stub the fragment's iframe
boots from, and only a real same-origin URL can make the fragment's `location`/`history`
truthful. It is a library you mount in the server you already run, not a service to deploy. See
`references/gateway.md`.

**Everything is public by default.** A manifest with no `access` is listed and loadable by
anyone. Restrict with `access.list` / `access.fetch`, which are independent.

**Never patch the host page.** Braid's invariant is that no host global or prototype is ever
modified. If you find yourself reaching for a global patch to make something work, you are
solving it at the wrong layer.

**Fragments are trusted, not sandboxed.** Same-origin realms share cookies, storage, and DOM
reachability. Namespace isolation is not a security boundary. The gateway *does* guarantee that
no markup a fragment sends can execute JavaScript in the host realm or navigate the host page.

## Quick start

```ts
// gateway, inside the server you already run
const gateway = createGateway({
  registry: [{ id: 'billing', endpoint: 'https://billing.internal', pierce: ['/billing/*'] }],
});
app.use(toNodeMiddleware(gateway)); // Express, NestJS, Connect, Vite
```

```ts
// host app (Angular)
providers: [provideRouter(routes), provideClientHydration(), provideBraid()];
```

```html
<braid-fragment name="billing" />
```

The fragment itself changes nothing. That is the whole point of the compat adapter, which is the
default when a manifest declares no `adapter`.

## Before you debug, check these five

Most reported failures are one of these, and each is invisible without looking:

1. **Hydration on both bootstraps.** Missing it makes the framework discard the server-rendered
   DOM, destroying the pierced fragment and booting a *second* realm. Symptom: two realms, a
   flicker, a re-fetch.
2. **After-navigation hook only.** Wiring host navigation to every router event reports a
   location before the URL changes, leaving fragments one navigation behind.
3. **The fragment's `<base href>` must not be rewritten.** It is what the fragment's router reads.
4. **Stale bundles.** Unhashed dev filenames with a long `max-age` serve yesterday's client.
5. **Cache variance.** Only page URLs that a fragment pierces vary (`sec-fetch-dest`); the
   `/__braid/*` namespaces vary on nothing. The gateway marks pierced pages `private` by default,
   so a shared cache seeing `public` on one means the edge rewrote it or the app opted out.

`references/failure-modes.md` has the full catalogue with symptoms and fixes. Run this in the
console first — it answers most of them at once:

```js
const slot = document.querySelector('fragment-slot');
({ state: slot.state, pierced: slot.hasAttribute('data-braid-pierced'),
   realms: document.querySelectorAll('iframe[name^="braid:"]').length /* expect 1 per slot */ });
```

## References

- `references/gateway.md` — registry, manifests, piercing, access rules, bindings, discovery
- `references/client.md` — slots, realms, adapters, props and events, the `FragmentEnv` contract
- `references/angular.md` — `provideBraid`, `<braid-fragment>`, SSR and hydration specifics
- `references/react.md` — `initBraidReact`, `<BraidFragment>`, host navigation without a fixed router
- `references/dev-workflow.md` — `braid dev`, live reload, Nx integration, what still needs config
- `references/failure-modes.md` — symptom → cause → prevention

## Do not

- Do not tell a fragment team to import a Braid package to be composed — compat requires nothing.
- Do not put authorization only in the registry: `access` governs composition, not the
  fragment's own API.
- Do not add `CUSTOM_ELEMENTS_SCHEMA` across an Angular app; use `<braid-fragment>`.
- Do not set `pierceCacheControl: 'preserve'` to get pierced pages cached at a CDN unless they are
  anonymous *and* `sec-fetch-dest` is in the cache key.
