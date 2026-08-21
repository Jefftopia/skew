# @braidlabs/angular-* — Angular bindings

Four independent packages. Each depends on `@braidlabs/skew`, never on a sibling.
All are standalone-only (no NgModules — configure via `provideSkew*()`),
signal-based (no RxJS surface), zoneless-safe, and SSR-safe.

Contents: [angular-core](#skewangular-core) · [angular-router](#skewangular-router)
· [angular-data](#skewangular-data) · [angular-workflow](#skewangular-workflow)

## @braidlabs/angular-core

DI and signal wrappers for `@braidlabs/skew` stores.

```ts
import { createSkewStoreToken, provideSkewStore, injectSkewStore, injectSkewSignal } from '@braidlabs/angular-core';
import { webStorageDriver } from '@braidlabs/skew';

export const USER_STORE = createSkewStoreToken<UserProfile>('USER_STORE');

export function provideUserStore() {
  return provideSkewStore(USER_STORE, UserProfileSchema, {
    driver: webStorageDriver('local'),
    keyPrefix: 'app-users',
  });
}
```

Consume with `injectSkewSignal(USER_STORE, key)` → `{ data, error, loading,
set, reload }`. It synchronously `peek()`s the store to initialize the signal
(no flash of empty state on sync drivers) and resolves in the background when
the driver is async or the data needs migration. `set()` is optimistic.

Use `injectSkewStore(USER_STORE)` when you need the raw store and want to
branch on `SkewResult` reasons yourself (services, guards) — e.g. treating
`ahead` as "refetch", not as an error.

## @braidlabs/angular-router

Chunk recovery for lazy routes that classifies the failure before acting —
flaky network, CDN miss, offline, deleted route, or stale origin each get a
different response, and none bricks the tab.

```ts
import { provideSkewRecovery, lazy } from '@braidlabs/angular-router';
import { BUILD_IDENTITY } from './generated/build-id';   // from skew-stamp

bootstrapApplication(App, {
  providers: [
    provideRouter(routes),
    provideSkewRecovery({ identity: BUILD_IDENTITY, manifestUrl: '/skew-manifest.json' }),
  ],
});

export const routes: Routes = [
  // id 'admin.routes' cross-references the manifest's modules map
  { path: 'admin', loadChildren: lazy('admin.routes', () => import('./admin/routes')) },
];
```

Behavior worth knowing:

- `lazy()` retries the import first (default 1 retry, 250ms backoff) —
  transient CDN misses resolve invisibly, no reload.
- `onStaleChunk` strategies: `'reload-at-target'` (default —
  `location.assign(targetUrl)`, preserving the navigation intent that
  Angular's deferred URL update would otherwise lose), `'reload-in-place'`,
  `'redirect-to-fallback'` (correct for deleted routes), `'notify'`,
  `'ignore'`, or a custom `(ctx: StaleChunkContext) => Action`.
- Loop prevention: probes the manifest, **refuses to auto-reload when the
  origin is older than the client** (reloading would fetch the same stale
  bundle forever), and caps auto-recoveries per session (`maxRecoveries`,
  default 1).
- Unsaved work: components call `trackUnsavedWork(() => form.dirty)` (cleans
  up on destroy). With `respectUnsavedWork` (default true), recovery degrades
  to `'notify'` instead of reloading over a half-filled form.
- Manual recovery UI: `inject(SkewRecoveryService)` exposes `pending()` signal
  and `recover()` — render a "new version available" banner on `'notify'`.

## @braidlabs/angular-data

Normalized entity store + tag invalidation + **durable mutation outbox**.
Exists because `resource()`/`httpResource()` are per-call caches with no
shared identity and no write primitive.

```ts
provideSkewData({
  owner: 'bulletin',            // required when persisting — see below
  persistOutbox: true,          // queued writes survive a reload
  buildId: BUILD_ID,
  onOutboxError: (msg, detail) => telemetry.error(msg, detail),
});

export const Bulletin = entity<Bulletin>({ name: 'bulletin', key: (b) => b.id });

readonly bulletins = query({
  loader: () => firstValueFrom(this.http.get<Bulletin[]>('/api/bulletins')),
  normalize: Bulletin,
  tags: () => ['bulletins'],
});
// Read through the store, NOT bulletins.value() — a component holding
// .value() owns a private copy that normalization can't update.
readonly rows    = this.store.selectAll(Bulletin);
readonly current = this.store.select(Bulletin, this.id);

readonly publish = mutation({
  id: 'bulletin.publish',                       // REQUIRED for outbox replay
  operation: (b: Bulletin) => firstValueFrom(this.http.post(`/api/bulletins/${b.id}/publish`, b)),
  optimistic: (tx, b) => tx.patch(Bulletin, b.id, { status: 'published' }),
  invalidates: (b) => [tag.entity(Bulletin, b.id), 'bulletins'],
  durability: 'outbox',
  schemaVersion: 41,
  onConflict: 'raise', // default │ 'accept' │ (conflict) => valueToStore
});
```

`optimistic` **describes** the change rather than applying it: the description
is queued, and every read returns `confirmed ⊕ pending`. So a failed write needs
no rollback (the entry is dropped), the prediction survives a reload, and the
other apps on the page see it too. `store.peekConfirmed(...)` is the server's
last word, `publish.conflict()` is a server that accepted the write and stored
something else, and `publish.hasPendingWrite()` is "not saved yet".

Outbox rules (they're constraints, not suggestions):

- Outbox mutations **must have an `id`** and **must be created during
  bootstrap**, not lazily in a click handler — after a reload there's no
  closure left; queued entries find their operation again by id.
- Flushing is strictly sequential; a failure stops the drain (entries often
  depend on each other). Optimistic state stays applied while queued — it *is*
  the queue, so the two cannot disagree.
- After `maxOutboxAttempts`, entries are dropped *loudly* via `onOutboxError`.
- A queue written by a newer build is left untouched (`ahead`) — replaying it
  would send payloads this build doesn't understand.
- Status signals: `inject(OutboxService)` → `pendingCount()`,
  `hasPendingWork()` ("3 changes waiting to sync"), `isFlushing()`.

Invalidation is tags, not TTLs — a mutation *knows* what it staled:
`tag.entity(Bulletin, '42')` → `bulletin#42`, `tag.all(Bulletin)` →
`bulletin#*`, `tag.collection('bulletins')`. Tags are getters, re-read per
invalidation, so signal-dependent tags stay correct.
Manual: `inject(CacheRegistry).invalidate('bulletins')`.

Known gaps: `resource()` can't normalize into this store (use `query()`), and
server-driven invalidation isn't shipped (tags are per-tab).

## @braidlabs/angular-workflow

Durable multi-step flows: step↔route mapping, guard-checked deep links, a back
button that walks the workflow, resumption after refresh *and* after a deploy
that changed the draft's shape, and idempotent terminal submit.

```ts
export const bulletinFlow = defineWorkflow({
  id: 'bulletin-creation',
  initial: { templateId: '', parishId: '', needsSetup: false, body: '' },
  // Version the draft — a draft is a message from a past deployment:
  schema: versioned<DataV1>('bulletin-data')
    .next<DataV2>('rename template to templateId', (p) => ({ ...p, templateId: p.template })),
  steps: {
    template: { route: 'template', validate: (d) => !!d.templateId, next: 'parish' },
    parish:   { route: 'parish',   validate: (d) => !!d.parishId,
                next: (d) => (d.needsSetup ? 'setup' : 'content') },
    setup:    { route: 'setup',    next: 'content' },
    content:  { route: 'content',  validate: (d) => d.body.length > 0, next: 'review' },
    review:   { route: 'review',   terminal: true,
                submit: (d, ctx) => api.publish(d, { idempotencyKey: ctx.runId }) },
  },
});
```

Definition errors (unknown `next`, dead-end step, duplicate routes) throw at
definition time, not mid-session.

```ts
// Component
readonly flow = injectWorkflow(bulletinFlow);
flow.current(); flow.data(); flow.canAdvance(); flow.progress();
flow.savedLocally(); flow.savedRemotely();       // separate promises, surface both
await flow.advance({ templateId: 'missale' });
await flow.submit();                              // concurrent submits are refused

// Routes: guarded per-step routes + redirect to first step
children: workflowRoutes(bulletinFlow, {
  template: () => import('./steps/template').then((m) => m.TemplateStep),
  // …
}),

// Setup
provideSkewWorkflow({
  basePath: '/bulletins/new',   // omit to run URL-less
  buildId: BUILD_ID,
  onDraftError: (msg, detail) => telemetry.warn(msg, detail),  // wire this
});
```

Design points to preserve when working with it:

- `runId` (idempotency key) is minted at run *start* and survives resume —
  double-clicks, retries, and cross-device resumes are the same intent.
- Guards are questions, never transitions: deep-linking to step four with step
  two blank redirects to the furthest reachable step via pure `pathTo()`.
- Progress follows the branch the data selects, not all declared steps.
- Test headlessly — the engine is pure:
  `testWorkflow(bulletinFlow).advance({...}).advance({...})` then assert
  `run.current()`; `.at(step, data)` seeds a state; no TestBed/router needed.

Known limitation (deliberate): all steps share one `TData` shape rather than
per-step accumulated types.
