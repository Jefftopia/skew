# Plan — React, Next.js, and web-component bindings

**Status: proposed, none of this is built.** The Angular binding shipped and the POC exercised it,
so this plan is written against what that actually taught us rather than from first principles.

---

## 0. First: write down the binding contract

Three bindings will drift unless the contract is explicit. Before writing React, extract what
`@skewkit/braid-angular` settled into, as a spec plus a shared conformance suite every binding
runs.

**Every binding provides exactly two things.**

**A fragment component**, wrapping `<fragment-slot>`:

| Concern | Contract |
| --- | --- |
| `name` | required; the fragment id |
| `src` | optional; **omitting it means bound** — the fragment follows the host location |
| `props` | set as a DOM **property**, never a serialized attribute |
| ready / error / event | the framework's idiomatic event mechanism, typed |
| `state` | `idle \| loading \| ready \| error`, reactive in the framework's own idiom |
| `reload()` | delegates to the element |
| SSR | **must render the element into SSR output**, effects browser-only |
| Elements | declares whatever the framework needs to accept unknown elements, once, internally |

**A setup function** that initializes Braid and supplies an **after-navigation** signal. Never a
before-navigation one: `NavigationStart` and its equivalents fire before the URL changes, and
fragments end up a navigation behind. This is the single most valuable thing a binding does, and
the reason it should not be left to each host.

A shared suite (framework-agnostic assertions driven per framework) should cover: the element is
rendered with the right attributes, `src` is absent when unbound, props land as a property,
events translate, listeners detach on unmount, and the setup function no-ops on the server.

**Estimate: 1 day**, and it makes the other three faster and consistent.

---

## 1. `@skewkit/braid-react`

### API

```tsx
// app entry
initBraid({ dev: import.meta.env.DEV });

// anywhere in the tree
<BraidFragment
  name="billing"
  props={{ cartId }}
  onReady={({ fragmentId }) => …}
  onError={(error) => …}
  onFragmentEvent={({ type, detail }) => …}
/>
```

`'use client'` at the top of the component module — it needs refs and effects.

### Router bridging without coupling to a router

React has no single router, so do not import one. Bridge on *location identity*:

```tsx
// react-router
useBraidHostNavigation(useLocation().key);
// TanStack Router
useBraidHostNavigation(useRouterState({ select: (s) => s.location.href }));
// anything else
useBraidHostNavigation(somethingThatChangesPerNavigation);
```

The hook calls `notify()` from a `useEffect` on change — effects run after commit, which *is* the
after-navigation signal. Ship one hook, plus documented one-liners per router. Optionally a
`<BraidRouterBridge value={…} />` for class components.

### Props and events under React 19

React 19 sets object props as properties on custom elements, which is what we want for `props`.
Custom **events** with colons (`braid:ready`) are still not JSX props — use a ref and
`addEventListener` with an `AbortController`, exactly as the Angular binding does.

### The risk to settle first: hydration

React's hydration is stricter than Angular's, and this is the one thing I would verify before
writing anything else.

The reasoning says it is fine: the parser converts `<template shadowrootmode>` into a shadow root
and does **not** leave the template in the light DOM, so React hydrating a pierced
`<fragment-slot>` sees an element with no children — matching what it rendered on the server.

But "the reasoning says it is fine" is exactly the sort of claim this project has been wrong about
before (the `:scope` selector, the double-boot). **Spike it in an afternoon**: SSR a React page
with a slot, pierce it, hydrate, and check for hydration warnings and whether the shadow root
survives. If it mismatches, `suppressHydrationWarning` on the element is the fallback, and we
should say so in the docs rather than leaving people to find it.

### Work

1. Contract + shared suite (above)
2. `BraidFragment` + `useBraidHostNavigation` + `initBraid` re-export — ~150 lines
3. Hydration spike, then SSR test with `renderToPipeableStream`
4. README with the router one-liners
5. Add a React fragment *and* a React host to the POC — the POC currently only proves Angular↔Angular

**Estimate: 2–3 days including the spike.**

---

## 2. `@skewkit/braid-next`

Next is not "React plus a bit". The component is the easy half; **where the gateway goes** is the
real design question, and the answer differs by deployment.

### The placement problem

Piercing needs to *read* the shell's HTML response. Next middleware cannot do that — it can
rewrite and redirect, but not transform a response body. So the two halves separate:

| Capability | Where it can live | Works on Vercel? |
| --- | --- | --- |
| Namespace routing (`/__braid/frag\|realm\|doc/*`) | a catch-all Route Handler | **yes** |
| Piercing (composing fragments into the page) | in front of Next: edge worker, reverse proxy, or a custom server | not in-process |

```ts
// app/__braid/[...braid]/route.ts — works everywhere, including Vercel
const gateway = createGateway({ registry });
export async function GET(request: Request) {
  return (await gateway.handle(request)) ?? new Response('Not found', { status: 404 });
}
export const POST = GET;
```

That alone makes fragments work: they boot client-side, assets and realms route correctly. You
lose only the server-rendered first paint.

For piercing, two honest options, and the docs should say which you are choosing:

- **Self-hosted**: a custom server wrapping `next({ ... }).getRequestHandler()` with
  `toNodeMiddleware`. Straightforward; costs you some Vercel-specific features.
- **Vercel / edge**: the gateway as an edge function or CDN worker in front of the deployment,
  wrapping the origin with `toFetchHandler`. This is the architecture's origin-front model and
  the one I would recommend — it also matches how you would front a legacy monolith.

### RSC interactions to verify

- **Soft navigation payloads.** Next fetches RSC payloads for the same page URL with `RSC: 1` and
  `sec-fetch-dest: empty`. Our document check requires `sec-fetch-dest: document`, so those pass
  through unpierced — which is correct. Worth an explicit test, and `RSC` may need adding to the
  `Vary` we already send on pierced pages.
- **`<BraidFragment>` must be a Client Component** but still SSRs its element, so the gateway has
  something to pierce into. Verify the element survives RSC serialization.
- **Streaming and Suspense.** Both stream; a fragment inside a Suspense boundary flushes late.
  Confirm the gateway's interleave and Next's flushing do not fight.

### A Next app used *as* a fragment

Next builds asset URLs at runtime from `assetPrefix`/`__webpack_public_path__`, not only in HTML —
so HTML rewriting cannot re-root them. Same shape as the Vite dev-server finding:

```js
// next.config.js of the fragment
assetPrefix: process.env.BRAID_NAMESPACE ?? undefined, // '/__braid/frag/billing'
```

This belongs in the docs as a hard requirement, not a footnote — it is the difference between a
Next fragment that boots and one that 404s its chunks.

### Work

1. Depends on the React binding
2. Route Handler recipe + `createBraidRouteHandler(gateway)` helper
3. Custom-server and edge-front recipes, with a decision table
4. `assetPrefix` guidance for Next-as-fragment
5. RSC behavior tests (soft nav, streaming, Suspense)

**Estimate: 3–5 days**, most of it verification rather than code.

---

## 3. Web-component MFEs

### First, the honest question: do they need Braid at all?

Often **no**, and the docs should say so. If a team ships a small widget as a custom element, the
host can load the script and use the element. That is simpler than Braid and there is no reason
to add a realm.

Braid earns its place when at least one of these is true:

- the widget's dependencies would collide with the host's (two versions of a shared library)
- it needs server-side rendering composed into the page
- it is really a whole application wearing an element's clothes
- it must be deployed and versioned independently, discoverable through a registry

Also worth stating plainly: **`<fragment-slot>` is itself a custom element**, so any framework can
use Braid today with no binding at all. Bindings are ergonomics, not a requirement.

### Where there *is* something to build: a `custom-element` adapter

This is the most interesting item in this plan, because it is small and it unlocks something
larger.

A well-behaved custom element does not need the compat illusion. It needs a mount point, props,
and a teardown signal — which is precisely `FragmentEnv`. So:

```ts
// manifest
{ "id": "rating", "adapter": "custom-element", "entry": "/rating.js", "element": "star-rating" }
```

```ts
// the adapter, in full, roughly
async mount(env, entry) {
  await env.realm.evaluate(entry);          // define the element in the fragment's realm
  const element = env.document.createElement(manifest.element);
  Object.assign(element, env.props);
  env.onPropsChanged((props) => Object.assign(element, props));
  env.root.append(element);
  env.signal.addEventListener('abort', () => element.remove());
}
```

Why this matters beyond web components: it would be **the first contract-mode adapter**, and it
is far simpler than a React or Angular one. It proves the `FragmentEnv` contract and the
contract-blob realm (already implemented and verified, currently with no consumer) against a real
workload. If the contract is wrong, this is the cheapest place to find out.

Constraints to document honestly:

- **Slotting across the boundary does not work.** Host light-DOM children cannot be projected into
  an element living in a fragment's realm. Props and events only.
- **Element registry is per realm**, which is the point: two fragments can define `star-rating`
  differently without colliding.
- **SSR** requires declarative shadow DOM from the fragment's own server; otherwise it is
  client-only.

### Work

1. `custom-element` adapter in `@skewkit/braid` — ~80 lines, plus manifest fields (`entry`, `element`)
2. Decide realm kind: contract-blob (no server round trip) is the natural fit and would be its
   first real user
3. A "should I use Braid for this widget?" section in the docs
4. Conformance vectors: props in, events out, teardown, two fragments defining the same tag name

**Estimate: 2 days**, and it de-risks every future contract adapter.

---

## Sequencing

1. **Binding contract + shared suite** — everything else depends on it
2. **React hydration spike** — a day, and it decides how the React binding is written
3. **`braid-react`**
4. **`custom-element` adapter** — small, high learning value, exercises contract mode
5. **`braid-next`** — most verification, benefits from everything above
6. **POC: a React fragment in the Angular host, and an Angular fragment in a React host** — the
   cross-framework case is the whole premise and nothing currently proves it

## What I would want decided before starting

1. **Is Next.js on Vercel a target?** If yes, the edge-front gateway recipe is the headline and
   the custom-server path is a footnote. If self-hosted, the reverse.
2. **Is the `custom-element` adapter worth pulling forward?** It is the cheapest way to validate
   contract mode, which currently has zero consumers — I would say yes, and do it before Next.
3. **Does the POC grow or fork?** Adding React apps to `braid-poc-*` keeps one runnable demo but
   makes it heavier; a second POC keeps each focused. I lean toward growing it, since the
   cross-framework composition is exactly what needs demonstrating.
