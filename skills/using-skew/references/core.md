# @braid/skew — versioned schemas, storage, and build-skew detection

Framework-agnostic, zero-dependency. Works in browsers, Node, workers, Deno.
Everything else in the Skew family builds on the primitives here.

## Versioned schemas

```ts
import { versioned } from '@braid/skew';

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

- Each `next()` is typed against the previous version's snapshot type — a
  migration that doesn't produce the next shape is a compile error.
- There is no terminal `build()`; the chain is the schema.
- The string name (`'weekly-content'`) is checked against the envelope's `n`
  field on read — reading a `parish` envelope with the `weekly-content` schema
  fails rather than guessing.
- Steps may be **bidirectional**: pass `{ up, down }` instead of a bare
  function. Declaring `down` enables `write({ as })` down-writes and lets
  results report `derivedPaths` (fields the downgrade had to guess),
  `lossyPaths` (fields the target version cannot carry), and `downgradedFrom`.
- Migrations that need "now" or randomness take a `MigrationContext`
  (deterministic clock/seed) rather than calling `Date.now()`/`Math.random()`
  directly — this keeps migrations replayable and testable
  (`defaultMigrationContext` is used when none is supplied).

### Reading and writing

```ts
const result = WeeklyContent.read(rawFromAnywhere);
if (result.ok) {
  use(result.value);                       // always the current shape
  if (result.migratedFrom !== null) { /* upgraded from an older version */ }
}

const envelope = WeeklyContent.write(value, buildId);  // stamp before persisting
```

Inspection without migrating: `isEnvelope(v)`, `peekVersion(v)`.
Result helpers: `isOk`, `isErr`, `valueOr`, `mapResult` — but at real
boundaries, branch on the reason (below) instead of collapsing to a default.

### Failure reasons and their remedies

| `result.reason` | Meaning | Correct response |
|---|---|---|
| `ahead` | written by a NEWER build; steps to read it don't exist here | refetch from server, leave data untouched, or cure via `@braid/contract` resolver — **never discard** |
| `gap` | a migration step is missing from the chain | report a bug (the chain was edited or a step lost) |
| `invalid` | not an envelope / malformed | discard and refetch |
| `threw` | a migration function threw | report a bug |
| `retired` | below the schema's declared `base` floor (`result.floor`) — steps were deliberately deleted after cleanup | discard and refetch, or offer a reset — a policy outcome, NOT a bug |

`ahead` is the reason this library exists. Collapsing it into `null` makes
every caller guess, and the guess is almost always "discard" — destroying data
that merely came from the future (a colleague on the new deploy, the user's
other device that updated first).

### Adopting on existing data

No backfill. Data without an envelope is treated as **v1**, so declare the
*current* shape as the base and records upgrade themselves as touched:

```ts
export const Parish = versioned<CurrentShape>('parish');  // v1 adopts everything
```

## Retiring old versions (cleanup)

Chains are append-only at the top, trim-only at the bottom, and never
renumbered. To delete old `.next()` steps:

1. Watch `result.migratedFrom` telemetry until the old versions stop
   arriving; enable `rewriteOnRead: true` on stores to accelerate this
   (read-repair re-persists migrated records at the current version).
2. Re-declare with the oldest surviving shape as the base and drop the
   retired steps: `versioned<V3>('draft', { base: 3 }).next<V4>(…)`.

Reads below the floor return `reason: 'retired'` with `floor` set — handle
as discard/refetch/reset, never as a bug. Bare data still adopts as v1, so
it reads as `retired` after a trim unless `assumeLegacyVersion: base` is set.
`write({ as })` below the floor throws. Registry/contract-supplied steps can
still cure a below-floor read. Retire conservatively for non-refetchable data
(drafts, outboxes — drain queues first), aggressively for caches.

## The schema registry

A module-level registry shared across schemas — this is what lets a build
pinned at an older version still *know about* newer steps (fed by contract
documents) so `read()` can downgrade newer data.

- `registerSchema(schema)` — explicit registration (import side effects are
  not relied upon).
- Fingerprint conflict detection: registering two different step chains under
  the same name/version is reported via `setRegistryConflictHandler`.
- `registryStep(name, to)` / `registryCeiling(name)` — lookups used by
  readers; `resetSchemaRegistry()` exists for tests.
- `versionedList(...)` wraps list payloads whose items are individually
  versioned.

## Versioned storage

Replaces `JSON.parse(raw) as T` — an assertion, not a check — with a store
that migrates on the way out and fails loudly at the boundary.

```ts
import { createVersionedStore, webStorageDriver, memoryDriver } from '@braid/skew';

const drafts = createVersionedStore(WeeklyContent, {
  driver: webStorageDriver('local'),   // or 'session', or memoryDriver()
  buildId: BUILD_ID,
  onReadFailure: (key, failure) => telemetry.warn('stale draft', { key, ...failure }),
});

await drafts.set('2026-12-06', content);          // envelopes + persists
const result = await drafts.get('2026-12-06');    // migrates + returns SkewResult
const immediate = drafts.peek('2026-12-06');      // sync; null on async drivers
```

- `peek()` exists for signal/hook initializers — no flash of empty state on
  synchronous drivers.
- `webStorageDriver` degrades to memory automatically under Safari private
  mode, disabled cookies, and SSR, and swallows quota errors on write — a
  failing cache must never break a save the user asked for.
- Custom persistence (IndexedDB, native, etc.): implement the `StorageDriver`
  interface.

## Build identity and skew detection

```ts
import { createVersionProbe } from '@braid/skew';

const probe = createVersionProbe({
  identity: { buildId: BUILD_ID, builtAt: BUILT_AT },  // from @braid/build
  manifestUrl: '/skew-manifest.json',                  // serve Cache-Control: no-store
});
const status = await probe.check();
```

| Status | Meaning | Correct response |
|---|---|---|
| `current` | in sync | — |
| `staleClient` | a newer deploy exists | offer a reload |
| `staleOrigin` | **origin older than us** | **do not reload — it will loop** |
| `differs` | can't be ordered (no timestamps) | treat conservatively |
| `unreachable` | offline/blocked | do not reload (you'd land on an error page) |

`staleOrigin` requires comparing build *timestamps* — that's why `builtAt` is
worth stamping. The probe collapses concurrent callers onto one request and
caches for `minIntervalMs` (default 10s).

Pure helpers: `compareBuilds(identity, manifest)` classifies without I/O;
`moduleWasRemoved(manifest, id)` distinguishes "route moved" (reload) from
"route deleted" (redirect to fallback), using the manifest's optional
`modules` map.

## HTTP version carriage

For APIs that stamp versions in headers instead of body envelopes:
`envelopeFromResponse(res, body, carriage)` re-attaches an envelope from
response metadata; `versionFromResponse` extracts the version;
`SKEW_CONTRACT_HEADER` (`skew-contract`) with
`parseSkewContractHeader`/`formatSkewContractHeader` carries
`{ name, version, url }` so a response can point at the contract that explains
it. See contract.md for the resolver that consumes this.
