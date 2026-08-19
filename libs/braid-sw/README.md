# @skewkit/braid-sw

Skew-aware asset serving for composed pages.

The classic micro-frontend white screen: a user has the page open, a deploy lands, they click
something that lazy-loads `main.abc123.js` — and it is gone, because the new build wrote
`main.def456.js`. Nothing on the page can recover. The request comes from the module loader, the
response is a 404, and the route dies.

A service worker is the **only** layer that can answer that request from a copy it kept.

Braid makes this materially cleaner than it is for a monolith. Every fragment's assets live under
`/__braid/frag/:id/*`, so each fragment gets **its own cache partition keyed by its own build**.
Fragment A at build 5 and fragment B at build 12 coexist, with no shared cache generation for one
deploy to invalidate on the other's behalf. A monolith's worker has one bucket and one answer.

---

## Two shapes

Both ship, because "the app already has a service worker" is not a safe assumption — least of all
for internal enterprise apps.

**A handler, for a worker you already own.** Braid never takes your `fetch` event:

```js
// your sw.js
import { braidFetchHandler } from '@skewkit/braid-sw';
const braid = braidFetchHandler({ buildId: BUILD_ID });

self.addEventListener('fetch', (event) => {
  const handled = braid(event.request); // null for anything not ours
  if (handled) event.respondWith(handled);
});
```

**A complete worker, for shells with none.** Same handler, already wired:

```js
// sw.js
import { setupBraidWorker } from '@skewkit/braid-sw';
setupBraidWorker({ buildId: BUILD_ID, precache: ['billing', 'notifications'] });
```

## Let the gateway serve it

```ts
createGateway({ registry, serviceWorker: true });                  // scope '/'
createGateway({ registry, serviceWorker: { scope: '/apps/' } });   // path-mounted deployments
```

```ts
import { registerBraidServiceWorker } from '@skewkit/braid';
await registerBraidServiceWorker({ buildId: BUILD_ID });
```

**A worker's scope is capped by the path it is served from.** A script at `/__braid/sw.js` defaults
to controlling `/__braid/` — enough for fragment assets, useless for the shell's own, which is the
chunk-failure case that matters most. Widening it needs `Service-Worker-Allowed` on the script
response, and the gateway is the one component already in front of the origin that can send it
without touching infrastructure config.

Claiming `/` sounds broad and costs nothing: scope precedence is longest-match, so a worker
registered at `/legacy/` still controls `/legacy/` whatever Braid claims. The root is a fallback,
not an exclusion — and the handler returns `null` outside the namespace anyway.

The generated script is **byte-stable across registry publishes**. Baking the snapshot id into it
would make every publish a worker update with its own waiting and activation lifecycle;
configuration churn must not become worker churn.

## What it will and will not do

| | |
| --- | --- |
| Serves a cached chunk when the origin 404s it | ✅ the deploy case |
| Serves from cache when the network is gone | ✅ offline |
| Answers a 500 from cache | ❌ that is an outage, and hiding it makes it someone else's mystery |
| Answers a POST | ❌ a cache cannot, and pretending turns a failed write into a stale success |
| Touches anything outside `/__braid/` | ❌ never |
| Caches fragment **documents** | ❌ composed markup's freshness is the gateway's business |

## Offline composition

Opt-in, and the piece with the most leverage: the worker runs **the gateway's own piercing**.

```js
setupBraidWorker({
  buildId: BUILD_ID,
  offline: { snapshotUrl: '/__braid/registry/pinned.json' },
});
```

The gateway core is runtime-neutral — no `node:` imports in the gateway, the registry, or the
rewriter — and a service worker is a web-standard runtime. So the worker holds the shell and the
fragment documents and interleaves them with the same `pierceShellHtml` the server runs. A second
implementation of piercing would be a second set of piercing bugs, found offline.

**It holds the parts, not the finished page.** Caching composed HTML would be simpler and much less
useful: the composed page is the cross-product of shell, fragments, and route. Holding the parts
means a route visited once composes offline afterwards, a fragment updates its own part, and a
fragment with nothing cached degrades to a placeholder instead of failing the page.

The shell is re-fetched with `sec-fetch-dest: empty`, which is how the gateway already distinguishes
a soft-navigation fetch from a document request — the same distinction every pierced response
declares in its `Vary` header, used from the other side.

Two things it will not do: compose while the network is reachable (the gateway is authoritative),
and cache a composed response (a page pierced against a registry that has since changed is exactly
the stale artifact this package exists to avoid). Composed pages carry
`x-braid-composed: offline` so a shell can say so rather than look merely slow.

## The worker is itself a skew vector

It is a long-lived deployment artifact that updates on its own schedule — a version boundary added
to a system whose purpose is managing version boundaries. So it gets the same discipline: it knows
its build and the snapshot it serves, and says so when they disagree with the page.

```ts
await registerBraidServiceWorker({
  buildId: BUILD_ID,
  onVersion: (report) => telemetry.record(report),
});
```

`claimClients` is off by default for the same reason. Claiming swaps the worker underneath a page
that is already running, so a page mid-session starts being served by a build it did not load
against. Waiting for the next navigation is the boring, correct behaviour.

## Reports that survive the tab closing

```js
setupBraidWorker({
  buildId: BUILD_ID,
  reports: { endpoint: '/__telemetry', driver: indexedDbRecordDriver({ database: 'braid-sw' }) },
});
```

The worker knows things nobody else can see — that a chunk was served from cache after the origin
404'd it, that its build disagrees with the page's. Handed to `onReport` those facts are
fire-and-forget, and the ones that go missing are disproportionately the interesting ones: a user who
hits a broken deploy is a user who closes the tab, and a `fetch` started during teardown loses that
race.

Queued reports are flushed on a Background Sync event — the browser wakes the worker when it judges
the network is back, with no page open and nothing racing teardown. Background Sync is Chromium-only,
so every activation also flushes opportunistically; a browser without it gets that path and nothing
else.

The queue is `@skewkit/data`'s outbox rather than a second implementation: one record per entry, so
appending never reads the queue first and two contexts cannot lose each other's writes. A refused
batch stays queued in full — partial credit would need the endpoint to say which records it took,
and no telemetry endpoint does.

## Not a data cache

The Cache API stores `Request → Response`. The data layer needs per-entity keys, versioned
envelopes, and migrate-on-read; the Cache API offers none of the three, and storing enveloped
entities as opaque response bodies would defeat the projection the whole design rests on.

**Cache API for assets and stubs. IndexedDB (`@skewkit/data`) for entities.**
