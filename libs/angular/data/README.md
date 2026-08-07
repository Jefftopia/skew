# @skew/angular-data

Normalized entity store, tag-based invalidation, and a **durable mutation outbox** for Angular.

Signals throughout. Zoneless-safe. No NgModules.

---

## Why this exists

Angular's `resource()` / `httpResource()` are good *reads*, but they are per-call caches:

```ts
const list = httpResource(() => '/api/bulletins');           // Bulletin[]
const one  = httpResource(() => `/api/bulletins/${id()}`);   // Bulletin
```

These share no identity. Updating `one` leaves the matching row inside `list` stale, and there is no integration point that lets a third-party store observe what either fetched. There is also **no write primitive at all** — no optimistic update, no rollback, and nothing that survives a reload.

This package supplies the missing half.

---

## Setup

```ts
provideSkewData({
  persistOutbox: true,          // queued writes survive a reload
  buildId: BUILD_ID,            // from @skew/build
  onOutboxError: (message, detail) => telemetry.error(message, detail),
});
```

---

## Identity first

```ts
export const Bulletin = entity<Bulletin>({ name: 'bulletin', key: (b) => b.id });
```

Declare each type once and export it. Identity is only useful if every query and mutation agrees on it.

## Reading

```ts
readonly bulletins = query({
  loader: () => firstValueFrom(this.http.get<Bulletin[]>('/api/bulletins')),
  normalize: Bulletin,
  tags: () => ['bulletins'],
});

// Read through the store — NOT through bulletins.value()
readonly rows      = this.store.selectAll(Bulletin);
readonly published = this.store.query(Bulletin, (b) => b.status === 'published');
readonly current   = this.store.select(Bulletin, this.id);
```

> **The mistake to avoid.** If a component holds `bulletins.value()`, it owns a private copy. Writing an updated record into the store changes nothing it can observe, and normalization buys you exactly nothing. Read through `select` / `selectAll` / `query`.

`normalize` handles the shapes real APIs return — a bare record, an array, or an envelope like `{ items: [...] }`. Anything unrecognised is left alone rather than guessed at.

## Writing

```ts
readonly publish = mutation({
  id: 'bulletin.publish',
  operation: (b: Bulletin) => firstValueFrom(this.http.post(`/api/bulletins/${b.id}/publish`, b)),
  optimistic: (tx, b) => tx.patch(Bulletin, b.id, { status: 'published' }),
  invalidates: (b) => [tag.entity(Bulletin, b.id), 'bulletins'],
  durability: 'outbox',
  schemaVersion: 41,
});

await this.publish.mutate(bulletin);
```

Everything written through `tx` is rolled back **precisely** if the operation fails — restoring the value from before the transaction, not an intermediate one.

---

## The outbox

The piece that cannot be built with in-flight request machinery. A mutation queued while offline has to survive a page reload — and after a reload there is no pending `Promise` to retry, no `HttpRequest` to intercept, and no closure left alive. Only something persisted can be replayed.

Which forces one API constraint:

```ts
mutation({ durability: 'outbox' })            // ✗ throws
mutation({ id: 'bulletin.publish', … })       // ✓ replayed by id
```

Operations are closures and closures don't serialise, so a queued entry finds its operation again by **id**. This also means outbox mutations must be created during bootstrap rather than lazily inside a click handler — a queue rehydrated at start-up needs somewhere to go.

**Behaviour worth knowing:**

- **Strictly sequential.** Entries frequently depend on each other (create a thing, then publish it); parallel flushing would race them. A failure stops the drain rather than skipping ahead.
- **Optimistic state is kept on queue.** From the user's point of view the change happened; it reaches the server when the network returns.
- **Permanently-failing entries are dropped, loudly.** After `maxOutboxAttempts` the entry is abandoned and reported through `onOutboxError` — never silently, because the user already navigated away believing it saved.
- **A queue written by a newer build is left untouched.** Replaying it would send payloads this build doesn't understand. `@skew/core` surfaces that as `ahead` rather than discarding the user's work.

```ts
const outbox = inject(OutboxService);
outbox.pendingCount();   // Signal<number>
outbox.hasPendingWork(); // Signal<boolean>  → "3 changes waiting to sync"
outbox.isFlushing();
```

---

## Invalidation

Tags, not TTLs. A time-to-live is a guess about when data went stale; a mutation *knows*.

```ts
tag.entity(Bulletin, '42')   // 'bulletin#42'
tag.all(Bulletin)            // 'bulletin#*'  — matches every bulletin#…
tag.collection('bulletins')  // 'bulletins'

inject(CacheRegistry).invalidate('bulletins');
```

Tags are supplied as a getter and re-read on each invalidation, so a query whose tags depend on signals (a route param, a filter) stays correct without re-subscribing. A subscriber that throws is isolated — one bad query can't stop the others refreshing.

---

## API

| Export | Purpose |
|---|---|
| `entity<T>({ name, key })` | Declare identity |
| `tag.entity` / `tag.all` / `tag.collection` | Build invalidation tags |
| `EntityStore` | `select` · `selectAll` · `query` · `peek` · `upsert` · `patch` · `remove` · `transaction` |
| `query(config)` | Read + normalize + subscribe to tags |
| `mutation(config)` | Write + optimistic + rollback + durability |
| `OutboxService` | `entries` · `pendingCount` · `flush` · `clear` |
| `CacheRegistry` | `invalidate` · `subscribe` |
| `provideSkewData(options)` | Wire it up |

---

## Known gaps

- **`resource()` can't normalize into this store**, so `query()` is a parallel primitive rather than an extension. Documented duplication we'd happily delete if Angular grew the hook.
- **Server-driven invalidation isn't shipped yet.** Tags currently work per-tab. The wire contract (`{ invalidate: string[] }` over SSE) is designed in [`plan.md`](../../../plan.md).
