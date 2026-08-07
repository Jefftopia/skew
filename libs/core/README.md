# @skew/core

Framework-agnostic primitives for surviving version skew.

No dependencies. No framework. Works in browsers, Node, workers, and Deno.

---

## The problem

Four failures that look unrelated are the same failure:

| Boundary | What crosses it | Symptom |
|---|---|---|
| Client ↔ origin | a lazy chunk request | `ChunkLoadError` after a deploy |
| Client ↔ API | a queued mutation, flushed later | 400s, or silent data corruption |
| Host ↔ fragment | props and events | mismatched contracts at runtime |
| **Past self ↔ present self** | a persisted draft or cache | `undefined` deep in a renderer |

In every case, two independently-versioned parties met at a boundary and had no way to discover that they disagreed.

This package is that missing primitive: **stamp what crosses a boundary with the version it was authored under, detect disagreement, then migrate forward or fail loudly.**

The fourth row is the one most teams miss. A draft written by build 41 and resumed by build 57 is the same problem as a client on 41 calling a server on 57 — the counterparty is just your own past deployment.

---

## Install

```sh
npm install @skew/core
```

---

## Versioned schemas

Declare a type's current version, its history, and the functions that move data between them in one place.

```ts
import { versioned } from '@skew/core';

// Snapshot shapes — frozen copies, never your live application types.
interface V1 { id: string; themeQuote?: { text: string } }
interface V2 { id: string; scriptureOfWeek?: { text: string } }
type V3 = V2 & { orderOfWorship: { setting: string; hymns: string[] } };

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

Reading migrates forward automatically:

```ts
const result = WeeklyContent.read(rawFromFirestore);

if (result.ok) {
  render(result.value);              // always the current shape
  if (result.migratedFrom !== null) {
    console.info(`upgraded from v${result.migratedFrom}`);
  }
}
```

Each `next()` is typed against the previous version, so a migration that does not actually produce the next shape is a compile error. There is no terminal `build()` call — the chain *is* the schema.

### The one rule

**A migration must never import your current application types or services.** Close each step over its own snapshot type (`V1`, `V2`, …). The moment a migration references a live interface, it silently changes meaning the next time that interface is edited, and your old migrations start lying about what they produce.

---

## Results, not exceptions

`read()` returns a discriminated result, because the failure modes need *different* remedies:

```ts
const result = WeeklyContent.read(raw);

if (!result.ok) {
  switch (result.reason) {
    case 'ahead':   return refetchFromServer();  // written by a NEWER build
    case 'gap':     return reportBug(result);    // missing migration step
    case 'invalid': return discardAndRefetch();
    case 'threw':   return reportBug(result);    // a migration failed
  }
}
```

### Why `ahead` matters

Data written by a newer build than the one reading it **cannot be migrated downward** — the information genuinely is not there. This is not hypothetical: a colleague saves from the new deploy while your tab is stale, or a user's phone updates before their laptop.

Collapsing this into `null` means every caller guesses, and the guess is almost always "discard it" — which destroys perfectly good data that merely came from the future.

---

## Versioned storage

The failure this prevents is the quiet one:

```ts
// Before: an assertion, not a check.
return JSON.parse(raw) as WeeklyContent;
```

The moment the model changes, every cached record on every user's machine has the old shape while being *typed* as the new one. You get `undefined` deep inside a renderer instead of a clean failure at the boundary.

```ts
import { createVersionedStore, webStorageDriver } from '@skew/core';

const drafts = createVersionedStore(WeeklyContent, {
  driver: webStorageDriver('local'),
  buildId: BUILD_ID,
  onReadFailure: (key, failure) => telemetry.warn('stale draft', { key, ...failure }),
});

await drafts.set('2026-12-06', content);
const result = await drafts.get('2026-12-06');   // migrated on the way out

// Sync read for signal/hook initialisers — no flash of empty state.
const immediate = drafts.peek('2026-12-06');     // null on async drivers
```

Drivers: `memoryDriver()`, `webStorageDriver('local' | 'session')`, or implement `StorageDriver` for IndexedDB or anything else. Web Storage degrades to memory automatically under Safari private mode, disabled cookies, and SSR, and swallows quota errors on write — a failing cache should never break a save the user asked for.

### Adopting on existing data

You do not need a backfill. Data with no envelope is treated as **v1**, so declare your *current* shape as the base and records upgrade themselves as users touch them.

```ts
export const Parish = versioned<CurrentShape>('parish');   // v1, adopts everything
```

---

## Build identity and skew detection

```ts
import { createVersionProbe } from '@skew/core';

const probe = createVersionProbe({
  identity: { buildId: BUILD_ID, builtAt: BUILT_AT },
  manifestUrl: '/skew-manifest.json',   // serve with Cache-Control: no-store
});

const status = await probe.check();
```

| Status | Meaning | Correct response |
|---|---|---|
| `current` | in sync | — |
| `staleClient` | a newer deploy exists | offer a reload |
| `staleOrigin` | **origin is older than us** | **do not reload — it will loop** |
| `differs` | cannot be ordered (no timestamps) | treat conservatively |
| `unreachable` | offline or blocked | do not reload; you would land on an error page |

`staleOrigin` is the case naïve implementations miss. If a CDN is serving a cached entry document or a region is lagging, reloading fetches the same stale bundle and fails again — forever. Detecting it requires comparing build *timestamps*, which is why `builtAt` is worth stamping.

The probe collapses concurrent callers onto a single request and caches for `minIntervalMs` (default 10s), so a page that fails three chunks at once still makes one network call.

### The manifest

Emit it at build time and serve it uncached:

```json
{
  "buildId": "a1b2c3d",
  "builtAt": "2026-08-07T10:14:00Z",
  "modules": { "admin.routes": { "file": "chunk-XYZ789.js" } }
}
```

`modules` is optional. With it, `moduleWasRemoved(manifest, id)` distinguishes "this route moved" from "this route was deleted" — which is the difference between reloading and redirecting to a fallback.

---

## API

| Export | Purpose |
|---|---|
| `versioned<T>(name, options?)` | Begin a schema declaration |
| `VersionedSchema.next<TNext>(desc?, fn)` | Add a version |
| `.read(raw)` / `.write(value, buildId?)` | Migrate in / envelope out |
| `isEnvelope(v)` / `peekVersion(v)` | Inspect without migrating |
| `createVersionedStore(schema, opts)` | Persistence with migration |
| `memoryDriver()` / `webStorageDriver()` | Built-in drivers |
| `createVersionProbe(opts)` | Build comparison against an origin |
| `compareBuilds(identity, manifest)` | Pure classification |
| `moduleWasRemoved(manifest, id)` | Route-deleted detection |
| `isOk` / `isErr` / `valueOr` / `mapResult` | Result helpers |

---

## Related packages

`@skew/core` is consumed by, but never requires, the framework bindings:

- `@skew/angular-router` — chunk-load recovery for the Angular router
- `@skew/angular-data` — versioned cache and durable mutation outbox
- `@skew/angular-workflow` — durable multi-step flows
- `@skew/react-*` — the same, for React
- `@skew/node` / `@skew/nest` — server-side negotiation and manifest serving

Each is independently installable. None requires the others.
