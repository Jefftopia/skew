# Skew — solution design

> One primitive, eight packages. Everything here exists to make **independently
> versioned parties negotiate at a boundary** instead of failing silently.

---

## 0. The thesis

Four failures that look unrelated are the same failure:

| Boundary | What crosses | Symptom today |
|---|---|---|
| Client ↔ origin | a lazy chunk request | `ChunkLoadError` after deploy |
| Client ↔ API | a mutation queued offline | 400s, or silent corruption |
| Host ↔ fragment | props / events | runtime contract mismatch |
| Past self ↔ present self | a draft or cache entry | `undefined` deep in a renderer |

Each is two independently-deployed parties meeting with no way to discover they disagree. `@skew/core` supplies the missing primitive; every other package is a consumer of it.

**Design rule for the whole workspace:** a consumer package may depend on `@skew/core`, never on a sibling. `@skew/angular-data` must not require `@skew/angular-router`. Nothing requires a server package. Adoption must be possible one package at a time.

---

## 1. `@skew/core` — done

Zero dependencies, framework-free. 44 tests, strict TS, ESM verified against Node.

| Module | Provides |
|---|---|
| `versioned` | `VersionedEnvelope`, fluent type-safe migration chain |
| `result` | `SkewResult` — `ahead` / `gap` / `invalid` / `threw` |
| `identity` | `compareBuilds`, `createVersionProbe`, `SkewStatus` |
| `storage` | `createVersionedStore`, sync/async drivers |

Two decisions the rest of the system leans on:

- **`ahead` is not an error to swallow.** Data from a newer build cannot be migrated downward; the only honest responses are refetch or update. Every consumer surfaces this rather than discarding.
- **Un-enveloped data reads as v1.** Adoption never requires a backfill.

---

## 2. `@skew/build` — build identity tooling *(new, prerequisite)*

Identity has to come from somewhere. Without it, `@skew/*-router` and the server packages have nothing to compare.

**Deliverable:** a tiny CLI plus an Nx executor.

```sh
skew-stamp --out src/generated/build-id.ts --manifest dist/skew-manifest.json
```

Emits:

```ts
export const BUILD_ID = 'a1b2c3d';
export const BUILT_AT = '2026-08-07T10:14:00Z';
```

and

```json
{ "buildId": "a1b2c3d", "builtAt": "…", "modules": { "admin.routes": { "file": "chunk-XYZ.js" } } }
```

**Decisions**

- A *generated file*, not a bundler `define`. Portable across Angular CLI, Vite, webpack, and testable without a build.
- `buildId` defaults to `git rev-parse --short HEAD`, falls back to a content hash, then a UUID. CI overrides via `SKEW_BUILD_ID`.
- `builtAt` is mandatory in practice — without timestamps two builds cannot be *ordered*, and ordering is what distinguishes "reload will fix this" from "reload will loop forever."
- The `modules` map is best-effort: derived from the bundler metafile when available, omitted otherwise. Consumers degrade to build-ID-only classification.

---

## 3. `@skew/angular-router` — chunk recovery

**Angular constraint that shapes the API:** `provideRouter`'s `RouterFeature` type cannot be constructed by third parties (the factory is internal). So integration is two public pieces rather than one feature:

```ts
// app.config.ts
provideSkewRecovery({
  identity: { buildId: BUILD_ID, builtAt: BUILT_AT },
  manifestUrl: '/skew-manifest.json',
  onStaleChunk: 'reload-at-target',
  retryAttempts: 1,
  maxRecoveries: 1,
});

// routes.ts — moduleId enables "was this route deleted?" classification
{ path: 'admin', loadChildren: lazy('admin.routes', () => import('./admin/routes')) }
```

`lazy()` is a plain higher-order function over the dynamic import — no framework hook required, works today.

### Strategies

| Strategy | Behaviour |
|---|---|
| `reload-at-target` *(default)* | `location.assign(targetUrl)` — preserves the attempted navigation |
| `reload-in-place` | `location.reload()` — abandons it |
| `redirect-to-fallback` | client-side redirect; correct when the route was deleted |
| `notify` | surface it, let the app choose |
| `ignore` | propagate `NavigationError` untouched |
| `(ctx) => Action` | application policy |

**Why `reload-at-target` is the default:** Angular's default `urlUpdateStrategy: 'deferred'` means the address bar still shows the *previous* route after a failed navigation. A naïve `location.reload()` therefore returns the user where they started and silently discards their navigation. This is the single most common bug in hand-rolled handlers.

### Classification before action

```ts
interface StaleChunkContext {
  targetUrl: UrlTree; currentUrl: UrlTree; error: unknown;
  attempt: number; isOnline: boolean;
  clientBuildId: string; serverBuildId?: string;
  moduleStillExists: boolean;    // route deleted in the new build?
  entryDocumentStale: boolean;   // origin older than us → reloading loops
  newAssetsReachable: boolean;   // probed and warmed
  hasBlockingGuard: boolean;
}
```

Ordering, deliberately: **retry → classify → dispatch.** Retry is a precondition, not a strategy — a transient CDN miss and a purged asset are indistinguishable from the error alone.

### Known gaps and their workarounds

- **`@defer` cannot be intercepted** — compiler-generated, no hook. Ship `<skew-defer-error/>` for the `@error` block. Per-site boilerplate; this becomes the concrete argument for a framework hook.
- **Guard introspection is impossible** — the router won't say whether a `CanDeactivate` would block. Ship a `DirtyStateRegistry` components opt into.

### Angular-specific posture

Zoneless-safe (no `NgZone` dependency), signals for all reactive surfaces, `inject()` only, no NgModules, SSR-safe via `isPlatformBrowser` guards on every `location` / `sessionStorage` touch.

---

## 4. `@skew/angular-workflow` — durable multi-step flows

Zero framework gaps; this is pure library territory.

```ts
export const bulletinFlow = defineWorkflow({
  id: 'bulletin-creation',
  version: 3,
  migrations: { 2: (v1) => …, 3: (v2) => … },   // via @skew/core
  persistence: { local: indexedDbDrafts(), remote: (s) => api.saveDraft(s) },
  steps: {
    template: { route: 'template', schema: TemplateSchema, next: 'parish' },
    parish:   { route: 'parish', schema: ParishSchema,
                next: (s) => s.parish.isComplete ? 'content' : 'setup' },
    review:   { route: 'review', terminal: true,
                submit: (s, ctx) => api.publish(s, { idempotencyKey: ctx.runId }) },
  },
});
```

```ts
const flow = injectWorkflow(bulletinFlow);
flow.current(); flow.data(); flow.canAdvance(); flow.progress(); flow.isDirty();
flow.advance(patch); flow.goTo('parish');
```

**The value is router integration, not the state machine.** XState is a fine machine and knows nothing about URLs, guards, or resumption. This library owns: step↔route mapping, guard-checked deep links (step 4 with step 2 incomplete → redirect), workflow-aware back button, refresh resumption, and automatic `CanDeactivate` wiring.

**Decisions**

- **Idempotency from the start.** A `runId` minted at workflow start, carried into the terminal submit. Users double-click, networks retry, workflows resume on a second device.
- **Two-tier persistence surfaced separately.** `savedLocally()` vs `savedRemotely()` — "safe on this device" and "safe on the server" are different promises and users can tell.
- **Headless.** Owns state, routing, persistence, validation. Renders nothing; integrates with reactive *and* signal forms.
- **Drafts are versioned via `@skew/core`.** A draft written by build 41 and resumed under 57 is the "past self ↔ present self" boundary. Without migration, every schema change silently corrupts in-flight drafts.

Testing surface (workflows are what break in production and are miserable to test through a UI):

```ts
const run = testWorkflow(bulletinFlow).at('parish', { parish: { isComplete: false } });
expect(run.advance().current()).toBe('setup');
```

---

## 5. `@skew/angular-data` — normalized cache + durable outbox

Largest and most invasive; built last of the Angular trio.

```ts
export const Bulletin = entity<Bulletin>({ name: 'bulletin', key: (b) => b.id });

const list = query(() => http.get<Bulletin[]>('/api/bulletins'), {
  normalize: [Bulletin], tags: () => ['bulletins'],
});

const publish = mutation({
  operation: (b) => http.post(`/api/bulletins/${b.id}/publish`, b),
  optimistic: (tx, b) => tx.patch(Bulletin, b.id, { status: 'published' }),
  invalidates: (b) => [tag.entity(Bulletin, b.id), 'bulletins'],
  durability: 'outbox',
  schemaVersion: 41,
});
```

**Why a `query()` rather than extending `resource()`:** `httpResource()` cannot normalize into a third-party store — the integration point does not exist. We ship a parallel primitive and document it as duplication to be deleted if Angular adopts the core.

**Components must read from the store, not the response.** This is the part teams get wrong: if a component holds the resolved response object, writing to the store changes nothing it can observe.

```ts
bulletin = store.select(Bulletin, id);          // Signal<Bulletin | undefined>
drafts   = store.query(Bulletin, b => !b.published);
```

**`durability: 'outbox'` is the centrepiece.** A persisted queue with ordered retry, rollback on permanent failure, and replay on reconnect is hard, identical everywhere, and impossible to express with in-flight request machinery — after a reload there is no request to retry. Entries carry `schemaVersion`, migrated before flush.

**Interceptors are an adapter, not the architecture.** They can *feed* the store; they cannot deliver it (the read path never returns through them), cannot see non-`HttpClient` sources, and cannot host an outbox that must survive reload.

Server-driven invalidation: a minimal wire contract (`{ invalidate: string[] }` over SSE) so tags work across users, not just tabs.

---

## 6. `@skew/react-*` — the same three, React-native  *(DEFERRED — out of current scope)*

Not a port. React lacks DI and has different reactivity rules, so the shapes differ.

**Cross-cutting React decisions**

- **`useSyncExternalStore` for every external read.** Module-level stores, not context-held values — context propagates re-renders to every consumer on any change.
- **react-compiler clean.** No manual `useMemo`/`useCallback` gymnastics, no mutation during render, no reading refs in render. Hooks return stable identities so the compiler can memoize freely.
- **Config via a provider component, state via module singletons.** Context carries configuration (stable, rarely changes); it never carries frequently-changing values.
- **Suspense-compatible but not Suspense-required.** `useQuery` exposes status; a `.suspend()` variant opts in.

```tsx
<SkewProvider identity={{ buildId: BUILD_ID, builtAt: BUILT_AT }} manifestUrl="/skew-manifest.json">

const status = useSkewStatus();                      // SkewStatus
const Admin = lazyWithRecovery('admin', () => import('./Admin'));
const flow  = useWorkflow(bulletinFlow);
const list  = useQuery(bulletinsQuery);
const pub   = useMutation(publishBulletin);
```

Router-agnostic: adapters for React Router and TanStack Router rather than a hard dependency on either.

---

## 7. `@skew/node` — server-side negotiation  *(DEFERRED — out of current scope)*

Framework-agnostic (plain `http`, Express, Fastify, Hono). Depends only on `@skew/core`.

```ts
const skew = createSkewServer({
  identity: { buildId: BUILD_ID, builtAt: BUILT_AT },
  manifest: () => readManifest(),
  accepts: { 'bulletin.publish': [41, 42, 43] },   // supported payload versions
});

skew.manifestHandler();       // GET /skew-manifest.json, no-store
skew.negotiate(headers);      // → SkewStatus for an incoming request
skew.readEnvelope(schema, body);  // migrate inbound payloads
```

**Decisions**

- Emits `409` with a typed body when a client sends a payload version outside the accepted window — a *declared* condition rather than a generic 400.
- Ships `X-Skew-Build-Id` on responses so clients can detect skew without a separate probe round-trip.
- Never requires the client packages; a Node service can adopt this alone.

---

## 8. `@skew/nest` — idiomatic NestJS bindings  *(DEFERRED — out of current scope)*

Thin layer over `@skew/node`.

```ts
@Module({ imports: [SkewModule.forRoot({ identity, accepts })] })

@Post('publish')
publish(@VersionedBody(PublishSchema) body: PublishV3) { … }   // migrated on the way in
```

Provides: `SkewModule.forRoot/forRootAsync`, `@VersionedBody()` param decorator, a response interceptor that stamps build identity, an optional guard rejecting incompatible clients, and a manifest controller.

---

## 9. Example apps

| App | Demonstrates |
|---|---|
| `apps/angular-demo` | Angular 22, zoneless, no NgModules — all three Angular packages against a deliberately-skewed build |
| `apps/react-demo` | React 19 + compiler — the same scenarios |
| `apps/api` | NestJS serving the manifest and negotiating payload versions |

Each app ships a **skew simulator**: a control that fakes a deploy (rotating the served manifest, 404ing a chunk, returning `409` on a mutation) so the recovery paths are demonstrable without an actual deployment.

---

## 10. Sequencing

1. ~~`@skew/build`~~ — done
2. `@skew/angular-router` — first real consumer; validates the core API
3. `@skew/angular-workflow` — zero gaps
4. `@skew/angular-data` — largest
5. `apps/angular-demo` + docs

**Deferred:** `@skew/react-*`, `@skew/node`, `@skew/nest`. Designs above remain
valid; the core contract was kept framework-neutral so they can be picked up
without reworking it.

## 11. Standards applied throughout

- **Angular:** signals, zoneless, standalone only, `inject()`, no NgModules, no decorators for DI, SSR-safe, `provide*` functions returning `EnvironmentProviders`.
- **React:** react-compiler clean, `useSyncExternalStore`, no context for hot values, RSC-aware (client boundaries marked).
- **Everywhere:** strict TS with `noUncheckedIndexedAccess`, ESM with explicit `.js` specifiers (the packaging trap already caught once in core), results over exceptions at boundaries, zero runtime dependencies outside peer frameworks.
