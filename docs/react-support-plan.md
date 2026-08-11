# First-class React support — implementation plan

**Scope:** `@skew/react-core`, `@skew/react-data`, `@skew/react-router`, plus an
`apps/react-demo`. Workflow (`@skew/react-workflow`) is deliberately **out of scope**
for this pass, per plan.md §6's deferral order.

**Target parity:** everything `@skew/angular-core`, `@skew/angular-data`, and
`@skew/angular-router` do today — versioned store DI + reactive reads, normalized
entity store + tags + durable outbox, and chunk-load classification/recovery — with
React-native shapes rather than a mechanical port.

---

## 0. The one decision that shapes everything else

Today, the interesting logic lives *inside Angular classes*:

| Behaviour | Where it lives now | Angular-specific? |
|---|---|---|
| Entity tables, transaction undo log, precise rollback | `data/src/lib/store.ts` (`@Injectable`) | Only `signal()` + `computed()` |
| Tag matching, wildcard semantics, failure isolation | `data/src/lib/cache-registry.ts` (`@Injectable`) | **No** — pure |
| Outbox drain ordering, attempt budget, `ahead` handling | `data/src/lib/outbox.ts` (`@Injectable`) | Only `signal()` |
| Query generation guard, normalization walk | `data/src/lib/query.ts` | `inject()` + `DestroyRef` |
| Mutation optimistic → rollback → outbox fallback | `data/src/lib/mutation.ts` | `inject()` |
| Retry + `ChunkLoadFailure` attribution | `router/src/lib/lazy.ts` | **No** — already pure |
| Classify → choose action → dispatch | `router/src/lib/recovery.service.ts` | Router events, `DOCUMENT` |
| Unsaved-work registry | `router/src/lib/unsaved-work.ts` | Only `signal()` |

That is roughly **900 lines of subtle, well-tested behaviour** whose Angular-ness is
almost entirely `signal()` and `inject()`. Two ways forward:

**A. Extract a framework-neutral engine, then bind twice. ← recommended**
Move the pure machinery into the existing `@skew/core` under a new `client/` folder
(no new package to publish, no new peer graph). Angular and React each become a thin
binding layer. Rollback semantics, drain ordering, and wildcard matching then have
*one* implementation and one test suite.

**B. Write React from scratch, duplicating the logic.**
Faster to first commit, and never touches shipped Angular code. But it guarantees the
two ecosystems drift — and "the outbox drops a permanently-failing entry loudly, but
only after `maxOutboxAttempts`, and a failure stops the drain rather than skipping
ahead" is exactly the kind of rule that silently diverges between two copies.

Plan A is assumed below. It costs one refactor step (§2) whose regression net already
exists: `store.spec.ts`, `query.spec.ts`, `outbox.spec.ts`, `recovery.service.spec.ts`,
`lazy.spec.ts` (≈1,150 lines of existing tests). The Angular **public API does not
change** — `EntityStore` stays an `@Injectable` with the same methods; it just
delegates.

---

## 1. Package layout

```
libs/
  core/src/lib/
    client/                     ← NEW: framework-neutral, still shipped as @skew/core
      cell.ts                   ReactiveCell — the 15-line reactivity seam
      entity-store.ts           createEntityStore()
      cache-registry.ts         createCacheRegistry()   (moved, unchanged logic)
      outbox.ts                 createOutbox()
      query-engine.ts           createQueryEngine()
      mutation-engine.ts        createMutationEngine()
      unsaved-work.ts           createUnsavedWorkRegistry()
      recovery-engine.ts        classify() + chooseAction() as pure functions
  angular/{core,data,router}    ← unchanged public API, now thin bindings
  react/
    core/                       @skew/react-core
    data/                       @skew/react-data
    router/                     @skew/react-router
apps/
  react-demo/                   React 19 + compiler, same scenarios as the shell demo
```

`@skew/react-*` depends on `@skew/core` and **never on a sibling** — the same adoption
rule stated in `libs/angular/README.md` and `technical-appendix.md`.

### The reactivity seam

One primitive, deliberately smaller than a store:

```ts
// libs/core/src/lib/client/cell.ts
export interface ReactiveCell<T> {
  get(): T;                              // current snapshot; referentially stable
  subscribe(listener: () => void): () => void;
}
```

- **Angular** wraps it: a `signal(0)` version counter bumped in `subscribe`, with
  `computed(() => (version(), cell.get()))`. The existing memoization caches in
  `EntityStore.select`/`selectAll` stay exactly where they are.
- **React** wraps it: `useSyncExternalStore(cell.subscribe, cell.get, cell.get)`.
  `get()` must return a stable reference when nothing changed — the store's existing
  "single write path, one notification" discipline already guarantees this, and it is
  the property `useSyncExternalStore` will punish us for getting wrong (infinite
  re-render loops). This gets a dedicated test.

Third argument to `useSyncExternalStore` is `getServerSnapshot`, supplied everywhere,
so RSC/SSR renders don't throw.

---

## 2. Step-by-step

### Step 1 — Workspace plumbing (no product code)

- Add deps: `react@^19`, `react-dom@^19`, `@types/react`, `@types/react-dom`,
  `@nx/react`, `@vitejs/plugin-react`, `@testing-library/react`,
  `@testing-library/dom`, `babel-plugin-react-compiler`, `eslint-plugin-react-hooks@^6`
  (v6 ships the compiler-correctness rules as lint).
- `tsconfig.base.json`: add three `paths` entries (`@skew/react-core`,
  `@skew/react-data`, `@skew/react-router`). Note `jsx` is currently unset at the base —
  set `"jsx": "react-jsx"` in each React lib's `tsconfig.lib.json`, not globally, so the
  Angular builds are untouched.
- `package.json` scripts: the `lint:libs` / `test:libs` / `build:libs` targets enumerate
  projects by name today. Add `react-core react-data react-router`, plus
  `test:react-*` / `build:react-*` entries matching the existing convention.
- `eslint.config.mjs`: add a `**/*.tsx` block enabling `react-hooks` recommended +
  compiler rules, scoped to `libs/react/**` and `apps/react-demo/**`.
- Build executor: `@nx/js:tsc` (same as `core`), **not** ng-packagr. ESM, `"type": "module"`,
  explicit `.js` specifiers in relative imports — plan.md §11 calls out that packaging
  trap as one already hit once.
- Test executor: `nx:run-commands` running `vitest` with `environment: 'jsdom'`
  (`jsdom` is already a devDependency) — mirroring `libs/core/vite.config.ts`.
- Each lib gets `package.json` with `peerDependencies: { react: "^19.0.0", "@skew/core": "^0.0.1" }`,
  `sideEffects: false`, and the `release`/`nx-release-publish` blocks copied from
  `libs/core/project.json`.

**Done when:** three empty libs build, lint, and test green; `npm run verify` passes.

### Step 2 — Extract the engine into `@skew/core/client`

Pure mechanical moves, one commit per module, Angular tests green after each:

1. `cache-registry.ts` → move verbatim, drop `@Injectable`, export `createCacheRegistry()`.
   Angular's `CacheRegistry` becomes `@Injectable` delegating to it. `tagsMatch` is
   already exported and pure — re-export from core for compatibility.
2. `entity-store.ts` → same state machine (`StoreState`, `UndoEntry`, `applyWrites`,
   `transaction()`), exposed as a `ReactiveCell<StoreState>` plus imperative
   `upsert/patch/remove/peek/clear`. `select`/`selectAll`/`query` stay in the *bindings*,
   because memoization strategy differs (Angular caches `computed`s by key; React
   derives per-hook with a stable selector).
3. `outbox.ts` → `createOutbox(options)` returning cells for `entries`/`isFlushing` and
   the same `register/load/enqueue/flush/clear`. Options object replaces `inject(DATA_OPTIONS)`.
4. `query-engine.ts` / `mutation-engine.ts` → the generation guard, `normalizeInto`, the
   optimistic/rollback/outbox-fallback ladder. Lifetime (`DestroyRef` vs `useEffect`
   cleanup) stays in the bindings.
5. `unsaved-work.ts` → `createUnsavedWorkRegistry()`.
6. `recovery-engine.ts` → `classify(input): StaleChunkContext` and
   `chooseAction(context, options): Promise<StaleChunkAction>` as **pure functions**.
   The guard-rail ladder (offline → stale origin → budget → unsaved work → module gone)
   is the part that must not fork. Dispatch stays framework-side; the session-scoped
   loop counter (`sessionStorage`, `skew:recoveries`) moves to core behind an injectable
   `now()`/storage seam so it stays SSR-safe and testable.

`lazy.ts` needs no move — it is already dependency-free apart from `isSkewDisabled()`;
React re-exports `lazy`, `ChunkLoadFailure`, `looksLikeChunkError`, `lazyDefaults` from
a shared home in core.

**Done when:** `npm run test:libs` and `npm run build:libs` pass with zero changes to
any Angular spec assertion. Any spec that *has* to change is a signal the extraction
altered behaviour — treat it as a bug, not as an expected edit.

### Step 3 — `@skew/react-core`

Mirrors `@skew/angular-core`: config via context, state via module-level stores.

```tsx
// Configuration only — stable, rarely changes. Never hot values.
<SkewProvider
  identity={BUILD_IDENTITY}
  manifestUrl="/skew-manifest.json"
>

// Stores are created at module scope, not in a component or a context value.
export const userStore = createSkewStore(UserProfileSchema, {
  driver: webStorageDriver('local'),
  keyPrefix: 'app-users',
});

function Profile() {
  // { data, error, loading, set, reload } — same shape as injectSkewSignal
  const user = useSkewStore(userStore, 'me');
  if (user.loading) return <Spinner />;
  if (user.error) return <MigrationFailed error={user.error} />;
  return <h1>Hello, {user.data?.name}</h1>;
}

const status = useSkewStatus();   // SkewStatus | null, from the shared probe
```

Design notes:
- `createSkewStore` returns a `VersionedStore<T>` **plus** a cell, so multiple
  components reading key `'me'` observe one another's writes. The Angular version gets
  this free via a root-provided token; React gets it via module scope. This is the
  concrete reason `@skew/react-core` cannot just re-export `createVersionedStore`.
- The synchronous `peek()` initialisation is preserved: `useSkewStore` seeds from
  `store.peek(key)` inside `getSnapshot`, so sync drivers render with data on the first
  paint — no flash of empty state, and no `useEffect`-then-setState waterfall.
- `set()` is optimistic then persists, matching `injectSkewSignal`.
- No context for the store value. Context carries `identity`/`manifestUrl`/probe only.

**Tests:** `@testing-library/react` — first-paint-has-data on a sync driver, `ahead`
surfacing as `error` rather than `null`, two components sharing one key, no re-render
storm under `StrictMode` double-invoke.

### Step 4 — `@skew/react-data`

```tsx
provideSkewData is replaced by props on the provider:

<SkewDataProvider persistOutbox buildId={BUILD_ID} onOutboxError={telemetry.error}>

export const Bulletin = entity<Bulletin>({ name: 'bulletin', key: (b) => b.id });

// Queries and mutations are declared at MODULE scope, not inside components.
export const bulletinsQuery = defineQuery({
  loader: () => fetch('/api/bulletins').then((r) => r.json()),
  normalize: Bulletin,
  tags: () => ['bulletins'],
});

export const publishBulletin = defineMutation({
  id: 'bulletin.publish',
  operation: (b: Bulletin) => fetch(`/api/bulletins/${b.id}/publish`, { … }),
  optimistic: (tx, b) => tx.patch(Bulletin, b.id, { status: 'published' }),
  invalidates: (b) => [tag.entity(Bulletin, b.id), 'bulletins'],
  durability: 'outbox',
  schemaVersion: 41,
});

function List() {
  useQuery(bulletinsQuery);                       // subscribes, refetches on tag invalidation
  const rows = useEntities(Bulletin);             // ← read the STORE, not the response
  const publish = useMutation(publishBulletin);
  const { pendingCount, isFlushing } = useOutbox();
  …
}

const one = useEntity(Bulletin, id);
const drafts = useEntityQuery(Bulletin, (b) => !b.published);
```

Design notes:
- **`define*` at module scope, `use*` in the component.** This is not stylistic. The
  outbox constraint from `angular-data`'s README — *"outbox mutations must be created
  during bootstrap, because a queue rehydrated at start-up needs somewhere to go"* — is
  much easier to violate in React, where the natural instinct is `useMutation({...})`
  inside a click handler's component. Splitting definition from subscription makes
  registration happen at import time and makes the rule enforceable: `defineMutation`
  throws on `durability: 'outbox'` without an `id`, exactly as `mutation()` does today.
- `useEntityQuery`'s predicate must be stable or it re-derives every render. Accept an
  inline arrow (react-compiler will memoize it) but derive with a `useMemo`-free
  selector over the cell snapshot, so behaviour is identical compiled or not.
- `useQuery` returns `{ status, error, isLoading, reload }` and deliberately **does not**
  return `value`. The Angular README's headline mistake is a component holding
  `bulletins.value()`. Withholding it from the hook's return type turns a documented
  warning into a compile error. A `useQueryValue(q)` escape hatch exists for
  non-normalizable payloads.
- A `.suspend()` variant per plan.md §6: `useQuery(q, { suspense: true })` throws the
  in-flight promise. Suspense-compatible, not Suspense-required.
- Outbox flush-on-reconnect and initial rehydrate move from
  `provideEnvironmentInitializer` into a `useEffect` in `SkewDataProvider`, guarded
  against StrictMode double-mount (idempotent `load()` already is).

**Tests:** port `store.spec.ts` / `query.spec.ts` / `outbox.spec.ts` assertions against
the React bindings — precise rollback, out-of-order response guard, sequential drain,
`ahead` queue left untouched, wildcard tag matching, plus render-count assertions
(mutating bulletin #42 must not re-render a component reading only #7).

### Step 5 — `@skew/react-router`

The hard part, and where a port would be wrong. Angular's recovery hangs off
`NavigationError` from a single injectable `Router`. React has no such event, and per
plan.md §6 we stay **router-agnostic**.

Three entry points instead:

```tsx
// 1. Component-level lazy — the React.lazy replacement.
const Admin = lazyWithRecovery('admin.routes', () => import('./Admin'));

// 2. The boundary that catches what lazy() throws during render.
<SkewBoundary fallback={<Recovering />}>{children}</SkewBoundary>

// 3. Router adapters supply the two things core can't know: where the user
//    was going, and how to navigate to the fallback route client-side.
<SkewRouterProvider adapter={reactRouterAdapter()} />   // or tanstackRouterAdapter()
```

```ts
export interface SkewRouterAdapter {
  currentUrl(): string;
  /** URL the failed navigation was heading to, if the router exposes it. */
  targetUrl(): string | undefined;
  /** Client-side redirect for 'redirect-to-fallback'. */
  navigate(to: string): void;
}
```

- `reactRouterAdapter()` reads `useLocation()` / the navigation state, and handles the
  data-router case where a `route.lazy()` rejection surfaces through `useRouteError()`.
- `tanstackRouterAdapter()` wraps the router instance directly.
- A `defaultAdapter()` using `window.location` + `history` ships too, so the package is
  usable with no router at all — `'reload-at-target'` degrades to `'reload-in-place'`
  when `targetUrl()` is undefined, which is the honest behaviour rather than guessing.
- The `'reload-at-target'` rationale — Angular's deferred `urlUpdateStrategy` leaving the
  address bar on the previous route — **does not apply to React Router**, which commits
  the URL differently. Document this: the default strategy stays `'reload-at-target'`,
  but the reason it matters is adapter-dependent, and the fallback above is why.

```tsx
useUnsavedWork(() => form.formState.isDirty);    // ← trackUnsavedWork equivalent

const { pending, recover, dismiss, status, updateAvailable } = useSkewRecovery();
{pending && <Banner onReload={recover} />}
```

Everything else — retry-before-classify, the guard-rail ladder, the `sessionStorage`
loop counter scoped to `buildId`, `moduleWasRemoved` for deleted routes, degrade to
`'notify'` on unsaved work — comes straight from the Step 2 engine and is **not
reimplemented**.

**Tests:** port `recovery.service.spec.ts` and `lazy.spec.ts` against the React
controller with a fake adapter — stale-origin never auto-reloads, budget exhaustion
degrades to notify, deleted module redirects, unsaved work blocks, offline notifies.

### Step 6 — `apps/react-demo`

React 19 + `babel-plugin-react-compiler`, Vite (`@nx/vite`), pointed at the existing
`apps/api` NestJS backend so both demos exercise one server. Reuses the shell demo's
skew simulator idea: rotate the served manifest, 404 a chunk, 409 a mutation.
`skew-stamp` already emits `build-id.ts` + `skew-manifest.json` and is framework-neutral —
wire it into the Vite build's `postbuild`.

Scope it to the three scenarios that read best: chunk recovery after a fake deploy,
offline outbox with a pending-count badge, and a migration of a persisted draft.

### Step 7 — Docs

- `libs/react/README.md` mirroring `libs/angular/README.md` (adoption rule, standards).
- A README per package, matching the existing voice: lead with the failure, then the
  API, then "known gaps".
- Update `libs/core/README.md`'s "Related packages" — `@skew/react-*` is currently
  listed as forthcoming.
- Update `docs/architecture.md` §1 diagram with a React Integration subgraph and the
  new shared-engine layer.
- Update `plan.md` §6/§10 to move React out of DEFERRED.

---

## 3. Sequencing and rough size

| Step | Depends on | Size |
|---|---|---|
| 1. Workspace plumbing | — | S |
| 2. Engine extraction | 1 | **L** — the risk sits here |
| 3. `@skew/react-core` | 2 | M |
| 4. `@skew/react-data` | 2, 3 | **L** |
| 5. `@skew/react-router` | 2, 3 | M–L (adapters add breadth) |
| 6. `apps/react-demo` | 3–5 | M |
| 7. Docs | 3–6 | S–M |

Steps 4 and 5 are independent of each other and can run in parallel once 3 lands.

---

## 4. Risks

- **The extraction changes Angular behaviour silently.** Mitigation: no spec edits
  allowed in Step 2; a changed assertion means a real regression.
- **`getSnapshot` identity instability** → infinite re-render. Mitigation: the store's
  single-write-path already returns stable maps; assert it directly, and run every hook
  test under `StrictMode`.
- **React 19 + compiler in an Angular-shaped Nx workspace.** TypeScript is `~6.0.3` and
  `moduleResolution: "bundler"` at the base — fine for React, but the React libs must
  not inherit `experimentalDecorators`/`emitDecoratorMetadata`. Set them off explicitly.
- **Router adapters are an open surface.** Ship React Router + TanStack + a
  no-router default; resist adding more until asked.
- **RSC.** Every hook file gets `'use client'`. `@skew/core` itself stays server-safe and
  must not gain a React import — that boundary is worth a lint rule.

---

## 5. Explicitly out of scope

- `@skew/react-workflow` — deferred by request; the engine extraction in Step 2 does not
  touch `libs/angular/workflow`, so it can be picked up later without rework.
- `@skew/node` / `@skew/nest` — unchanged from plan.md's deferral.
- Server-driven invalidation (`{ invalidate: string[] }` over SSE) — still a known gap
  on the Angular side; adding it to React first would fork the wire contract.
