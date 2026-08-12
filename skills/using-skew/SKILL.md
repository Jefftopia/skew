---
name: using-skew
description: >-
  How to correctly use the @skewkit/* npm packages (@skewkit/core, @skewkit/contract,
  @skewkit/build, @skewkit/angular-core, @skewkit/angular-router, @skewkit/angular-data,
  @skewkit/angular-workflow) for surviving version skew: versioned schemas and
  data migrations, contract documents, chunk-load recovery, durable outboxes,
  and resumable workflows. Use this skill whenever a task involves any @skewkit
  package, schema/data migrations for persisted or cached data, ChunkLoadError
  recovery after deploys, localStorage/IndexedDB caches that break when a model
  changes, offline mutation queues, multi-step wizard drafts, API version
  negotiation, or "data written by a newer build" problems — even if the user
  never says the word "skew". Also use it when adding a new version to an
  existing versioned schema or contract document, since editing old versions
  incorrectly silently corrupts users' data.
---

# Using the Skew libraries

Skew treats four failures as one problem: **two independently-versioned parties
meet at a boundary with no way to discover they disagree.** A stale client
calling a new API, a lazy chunk 404ing after a deploy, a host/fragment contract
mismatch, and — the one teams miss — *your own past deployment*: a draft or
cache written by build 41 and read by build 57.

The fix is always the same shape: **stamp what crosses a boundary with the
version it was authored under, detect disagreement, then migrate forward or
fail loudly.**

## Which package do I need?

| Symptom / task | Package | Reference |
|---|---|---|
| Persisted/cached data breaks when the model changes; `JSON.parse(raw) as T` | `@skewkit/core` (`versioned`, `createVersionedStore`) | [references/core.md](references/core.md) |
| Detect stale client vs stale origin; build identity; `skew-manifest.json` | `@skewkit/core` (`createVersionProbe`) + `@skewkit/build` (`skew-stamp`) | [core.md](references/core.md), [build.md](references/build.md) |
| Old clients must read data from a *newer* API without redeploying | `@skewkit/contract` | [references/contract.md](references/contract.md) |
| Generate frozen version types from a contract JSON | `@skewkit/build` (`skew-contract gen`) | [references/build.md](references/build.md) |
| Wire a versioned store into Angular DI / signals | `@skewkit/angular-core` | [references/angular.md](references/angular.md) |
| `ChunkLoadError` after deploys; lazy route recovery without reload loops | `@skewkit/angular-router` | [references/angular.md](references/angular.md) |
| Normalized entity cache, optimistic writes, offline outbox in Angular | `@skewkit/angular-data` | [references/angular.md](references/angular.md) |
| Multi-step wizard whose draft must survive refresh *and* deploys | `@skewkit/angular-workflow` | [references/angular.md](references/angular.md) |

Adoption rule: every package depends on `@skewkit/core` and **never on a
sibling**. Adopt one, all, or none — never install a package the task doesn't
need. (READMEs mention `@skewkit/react-*` / `@skewkit/node` / `@skewkit/nest` as related
work; only the packages in the table above are shipped. For servers, use
`@skewkit/core` + `@skewkit/contract` directly — they are dependency-free and run
anywhere.)

## The rules that protect user data

These are the mistakes that pass review and then corrupt data in production.
Hold every change against them.

1. **Migrations close over frozen snapshot types, never live application
   types.** Each `versioned<V1>().next<V2>(…)` step is written against `V1`,
   `V2` interfaces that are *copies frozen at that version*. The moment a
   migration references a live interface, editing that interface silently
   changes what old migrations produce. With `@skewkit/contract`, `skew-contract
   gen` generates these frozen types so they can't drift.

2. **Never edit or reorder an existing `next()` step or contract step.** Data
   already written under a version is decoded by that exact step forever. New
   shape ⇒ append a new step. Wrong old step ⇒ append a *correcting* step.

3. **Handle `ahead` as its own case, never as "invalid".** `read()` returns a
   discriminated result; `ahead` means the data came from a newer build and the
   information to migrate it down genuinely isn't in this bundle. Discarding it
   destroys good data. Correct responses: refetch from the server, leave it
   untouched (the outbox does this), or cure it with
   `createContractResolver().readResolving()` which fetches the origin's
   contract and reads a labeled, lossy downgrade.

4. **`read()`/`get()` return results, not values.** Branch on `result.ok` and
   on `result.reason` (`ahead` | `gap` | `invalid` | `threw`) — each needs a
   different remedy. Don't `valueOr(null)` at a boundary where the reasons
   matter.

5. **No backfills needed for adoption.** Un-enveloped data is treated as v1.
   Declare the *current* shape as the base version and existing records upgrade
   as they're touched: `versioned<CurrentShape>('parish')`.

6. **Never auto-reload when the origin is stale.** `staleOrigin` (origin older
   than the running client) means a reload fetches the same stale bundle and
   loops forever. The probe and `@skewkit/angular-router` classify this; keep the
   distinction when building your own recovery.

7. **Contract documents carry data, never code.** Ops come from a closed
   whitelist (`rename`, `move`, `wrap`, `hoist`, `map`, `default`, `drop`,
   `convert`, `const`), each with a known inverse. Semantic transforms are
   named `"code"` steps whose implementations ship in the consuming bundle; a
   consumer missing one degrades loudly with `gap`. A contract accumulating
   `code` steps wanted a new resource, not a new version.

## Canonical quick start (browser cache, framework-free)

```ts
import { versioned, createVersionedStore, webStorageDriver } from '@skewkit/core';

// Frozen snapshots — copies, not imports of live types.
interface V1 { id: string; themeQuote?: { text: string } }
interface V2 { id: string; scriptureOfWeek?: { text: string } }

export const WeeklyContent = versioned<V1>('weekly-content')
  .next<V2>('rename themeQuote to scriptureOfWeek', (p) => ({
    id: p.id,
    scriptureOfWeek: p.themeQuote,
  }));
// No .build() — the chain IS the schema. Each next() typechecks against the previous version.

const drafts = createVersionedStore(WeeklyContent, {
  driver: webStorageDriver('local'),   // degrades to memory under private mode/SSR
  buildId: BUILD_ID,                   // from @skewkit/build's generated build-id.ts
  onReadFailure: (key, f) => telemetry.warn('stale draft', { key, ...f }),
});

const result = await drafts.get('2026-12-06');  // migrated on the way out
if (!result.ok) {
  switch (result.reason) {
    case 'ahead':   /* refetch from server — do NOT discard */ break;
    case 'gap':
    case 'threw':   /* report a bug */ break;
    case 'invalid': /* discard and refetch */ break;
  }
}
```

## Angular conventions

All `@skewkit/angular-*` packages are standalone-only (`provideSkew*()`
functions, no NgModules), signal-based, zoneless-safe, and SSR-safe. Wire
stores through DI (`createSkewStoreToken` + `provideSkewStore`), consume with
`injectSkewSignal` to avoid empty-state flashes, and generate `BUILD_ID` /
`skew-manifest.json` with `skew-stamp` as part of the build. Details and
per-package recipes: [references/angular.md](references/angular.md).

## Reading order for a new integration

1. This file (you're here) — pick packages from the table.
2. The matching reference file(s) for API-level guidance.
3. When exposing or consuming versioned data over HTTP, read
   [references/contract.md](references/contract.md) even if you start with
   code-shipped chains — the `ahead` story decides whether you'll need
   contracts later, and adopting the envelope early is cheap.
