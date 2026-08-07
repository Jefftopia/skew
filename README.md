<p align="center">
  <img src="assets/fin.png" width="380" alt="Fin, the Skew mascot: a friendly blue shark swimming with its dorsal fin breaking the waterline" />
</p>

<h1 align="center"><i>Skew</i></h1>

<p align="center">
  <em>Survive the deploy that lands while your users are still using the app.</em>
</p>

<p align="center">
  <img alt="Angular 22" src="https://img.shields.io/badge/Angular-22-DD0031?style=flat-square" />
  <img alt="TypeScript 6.0" src="https://img.shields.io/badge/TypeScript-6.0-3178C6?style=flat-square" />
  <img alt="181 tests passing" src="https://img.shields.io/badge/tests-181%20passing-2EA043?style=flat-square" />
  <img alt="zero core dependencies" src="https://img.shields.io/badge/core%20deps-0-8FBFE0?style=flat-square" />
  <img alt="MIT" src="https://img.shields.io/badge/license-MIT-1E3A5F?style=flat-square" />
</p>

<p align="center">
  <a href="#you-only-ever-see-the-fin">Why</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#packages">Packages</a> ·
  <a href="#skewcore">Core</a> ·
  <a href="#skewangular-router">Router</a> ·
  <a href="#why-not-just">Why not…</a> ·
  <a href="#development">Development</a>
</p>

---

## You only ever see the fin

A user reports `ChunkLoadError`. You add a `location.reload()` and move on.

The chunk was never the problem. It was the visible tip of something larger: **two independently deployed parties met at a boundary with no way to discover they disagreed.** That same shape surfaces in four places, and most teams fix them one at a time, differently, and badly.

| Boundary                      | What crosses it           | How it fails                    |
| ----------------------------- | ------------------------- | ------------------------------- |
| Client ↔ origin              | a lazy chunk request      | `ChunkLoadError` after a deploy |
| Client ↔ API                 | a mutation queued offline | `400`s — or silent corruption   |
| Host ↔ fragment              | props and events          | contract mismatch at runtime    |
| **Past self ↔ present self** | a draft, a cache entry    | `undefined` deep in a renderer  |

That last row is the one nobody names. A draft written by build 41 and resumed under build 57 is _exactly_ the same failure as a client on 41 calling a server on 57. The counterparty is just your own past deployment.

**Skew supplies the missing primitive:** stamp whatever crosses a boundary with the version it was authored under, detect disagreement, then migrate forward — or fail loudly, on purpose.

---

## Quick start

```sh
npm install @skew/core @skew/build
```

**1. Give your build a name.**

```jsonc
// package.json
{
  "scripts": {
    "prebuild": "skew-stamp --out src/generated/build-id.ts",
    "postbuild": "skew-stamp --manifest dist/app/browser/skew-manifest.json --assets dist/app/browser",
  },
}
```

**2. Version anything that outlives the code that wrote it.**

```ts
import { versioned } from '@skew/core';

interface DraftV1 {
  id: string;
  body: string;
}
interface DraftV2 {
  id: string;
  title: string;
  body: string;
}

export const Draft = versioned<DraftV1>('draft').next<DraftV2>('lift the first line into a title', (p) => ({
  id: p.id,
  title: p.body.split('\n')[0] ?? '',
  body: p.body,
}));

const result = Draft.read(whateverWasInStorage); // migrated, whatever version it was
if (result.ok) render(result.value);
```

That's the whole idea. Everything else is applying it in a specific place.

---

## Packages

| Package                                               | What it does                                                                                | Status       |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------ |
| **[`@skew/core`](libs/core)**                         | Envelopes, migration chains, build identity, skew detection. No dependencies, no framework. | **44 tests** |
| **[`@skew/build`](libs/build)**                       | `skew-stamp` — generates build identity and the manifest.                                   | **11 tests** |
| **[`@skew/angular-router`](libs/angular/router)**     | Recovers from stale chunks without bricking the tab.                                        | **34 tests** |
| **[`@skew/angular-data`](libs/angular/data)**         | Normalized entity store, tag invalidation, durable mutation outbox.                         | **50 tests** |
| **[`@skew/angular-workflow`](libs/angular/workflow)** | Durable multi-step flows surviving refresh, deploy, and device.                             | **42 tests** |

> **Adoption rule.** Every package depends on `@skew/core` and never on a sibling. Take one, take three, take none of the Angular ones. Nothing is load-bearing for anything else.

---

## `@skew/core`

### Migration chains TypeScript actually checks

```ts
export const WeeklyContent = versioned<V1>('weekly-content')
  .next<V2>('rename themeQuote to scriptureOfWeek', (p) => ({
    id: p.id,
    scriptureOfWeek: p.themeQuote,
  }))
  .next<V3>('introduce orderOfWorship', (p) => ({
    ...p,
    orderOfWorship: { setting: '', hymns: [] },
  }));
```

Each step is typed against the previous version, so a migration that doesn't produce the next shape is a **compile error**. There's no terminal `.build()` — the chain _is_ the schema.

> **The one rule.** A migration must never import your current application types. Close each step over its own snapshot (`V1`, `V2`, …). The moment a migration references a live interface, it silently changes meaning the next time you edit that interface — and your old migrations begin lying about what they produce.

### Failures you can act on

```ts
if (!result.ok) {
  switch (result.reason) {
    case 'ahead':
      return refetch(); // written by a NEWER build
    case 'gap':
      return reportBug(); // a migration step is missing
    case 'invalid':
      return discard();
    case 'threw':
      return reportBug(); // a migration blew up
  }
}
```

**Why `ahead` gets its own case.** Data from the future _cannot_ be migrated downward — the information isn't there. Collapsing that into `null` means every caller guesses, and the guess is always "discard it," which destroys perfectly good data. This happens more than you'd expect: a colleague saves from the new deploy while your tab is stale; a phone updates before the laptop does.

### Storage that doesn't lie to you

```ts
// Before — an assertion, not a check:
return JSON.parse(raw) as WeeklyContent;
```

The day the model changes, every cached record on every user's machine has the old shape while being _typed_ as the new one. You get `undefined` deep inside a renderer instead of a clean failure at the boundary.

```ts
const drafts = createVersionedStore(WeeklyContent, {
  driver: webStorageDriver('local'),
  onReadFailure: (key, failure) => telemetry.warn('stale draft', { key, ...failure }),
});

await drafts.set('2026-12-06', content);
const stored = await drafts.get('2026-12-06'); // migrated on the way out
const now = drafts.peek('2026-12-06'); // sync — no flash of empty state
```

**Adopting on existing data needs no backfill.** Un-enveloped records read as v1, so declare your _current_ shape as the base and rows upgrade themselves as users touch them.

---

## `@skew/angular-router`

```ts
// app.config.ts
provideSkewRecovery({
  identity: BUILD_IDENTITY,               // from @skew/build
  manifestUrl: '/skew-manifest.json',
});

// routes.ts — the id is what lets us ask "was this route deleted?"
{ path: 'admin', loadChildren: lazy('admin.routes', () => import('./admin/routes')) }
```

That's the setup. What it _doesn't_ do is the interesting part.

### Reloading is frequently the wrong answer

```
chunk fails
   │
   ├─ retry  (transient CDN miss? flaky network?) ──→ recovered, nobody notices
   │
   └─ still failing → classify ─┬─ offline?        → don't reload (browser error page)
                                ├─ origin older?   → don't reload (infinite loop)
                                ├─ budget spent?   → don't reload
                                ├─ unsaved work?   → don't reload (data loss)
                                ├─ route deleted?  → redirect, don't reload (404)
                                └─ otherwise       → reload at the TARGET url
```

Three of those deserve spelling out.

**Reload at the _target_, not in place.** Angular's default `urlUpdateStrategy` is `'deferred'`, so after a failed navigation the address bar still shows the _previous_ route. A naïve `location.reload()` returns the user where they started and silently swallows the navigation they attempted. This is the single most common bug in hand-rolled handlers.

**The origin can be older than you are.** If a CDN is serving a cached entry document, reloading fetches the same stale bundle, fails identically, and reloads again — forever. A bricked tab. We compare build _timestamps_ and refuse.

**Retry is a precondition, not a strategy.** A flaky network, an edge miss, and a genuinely purged asset are indistinguishable from the error alone. One bounded retry resolves the first two without inflicting a page reload on anyone.

### Unsaved work

Angular won't let a library ask the router whether a `CanDeactivate` guard would block, so components opt in:

```ts
export class BulletinEditor {
  constructor() {
    trackUnsavedWork(() => this.form.dirty); // auto-cleans on destroy
  }
}
```

### Telling the user when you shouldn't act automatically

```ts
@if (skew.pending()) {
  <div class="banner">
    A new version is available.
    <button (click)="skew.recover()">Reload</button>
  </div>
}
```

`pending()`, `status()`, and `updateAvailable()` are signals. Zoneless-safe, SSR-safe, no NgModules.

---

## Why not just…

**…`location.reload()` on `ChunkLoadError`?** That's the naïve branch above. It works until the origin is stale (infinite loop), the user is offline (error page), the route was deleted (404), or somebody had a half-written form open (data loss).

**…let CDN caching keep old chunks alive?** Caching isn't retention. Edges evict on LRU regardless of TTL, and cold edges never had the object — both go to origin, and if your pipeline ran `s3 sync --delete` or rolled a container, it's gone. The CDN converts a deterministic failure into an intermittent, region-dependent one, which is _worse_ to debug. Retention is the real mitigation; if you have it, you need less of this.

**…Vercel Skew Protection?** Excellent, and it solves the asset half at the platform layer. Unavailable on Kubernetes, internal nginx, IIS, or on-prem — which is most enterprise Angular. And it doesn't touch API contract skew, the more dangerous half.

**…a state library for drafts?** They store state; they don't _version_ it. The failure here isn't losing the draft — it's resuming a draft whose shape has since changed.

---

## Development

```sh
npm install

npx nx test core                 # 44
npx nx test build-tools          # 11
npx nx test angular-router       # 34
npx nx test angular-data         # 50
npx nx test angular-workflow     # 42
npx nx run-many -t test

npx nx build core                # → dist/libs/core
npx nx run-many -t build
```

**Workspace conventions**

- Strict TypeScript with `noUncheckedIndexedAccess`
- ESM with explicit `.js` specifiers, enforced by `moduleResolution: nodenext` — added after a packaging bug that passed both `tsc` _and_ `nx build` and would still have broken every consumer at runtime
- Angular: signals, zoneless, standalone-only, `inject()`, no NgModules, `provide*` returning `EnvironmentProviders`
- Results over exceptions at every boundary
- Zero runtime dependencies outside peer frameworks

Design rationale for every package — including the constraints that forced each API shape and the known gaps with their workarounds — lives in **[`plan.md`](plan.md)**.

---

## Meet Fin

<img src="assets/fin.png" width="180" align="right" alt="Fin the shark" />

Fin is the project mascot, and a decent mental model besides.

What you see is the fin above the waterline: a `ChunkLoadError`, a `400`, an `undefined` in a template. What's actually moving is underneath — a client and a server that have quietly stopped agreeing about which version of the world they're in.

Fin is friendly. Fin is also still a shark. Deploy accordingly.

<br clear="right" />

---

## License

MIT
