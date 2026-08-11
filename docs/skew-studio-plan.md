# Plan: Skew Studio — a playground for watching migrations happen

## The ask, and the reframe

GraphiQL for skew: paste a payload, see the up/down cast mechanism work, in
an Express API, a NestJS API, and in the browser.

The reframe I'd propose: **don't build three tools — build one UI over one
introspection surface, with three thin mounts.** GraphiQL works because
GraphQL carries introspection in the protocol. Skew already has that
property twice over, and one gap:

1. **Contract documents are pure data.** Ops (`rename`, `move`, `wrap`, …)
   are interpretable in any JS runtime — including the browser. A studio
   can fetch `/.well-known/skew/contracts/:name` from *any* skew-enabled
   origin and replay every step client-side, no server cooperation needed.
   This is strictly better than GraphiQL's model: the studio doesn't send
   queries to the server, it downloads the *rules* and runs them locally.
2. **The schema registry knows every code-shipped chain at runtime.**
   `registerSchema()` already centralizes names, versions, step
   descriptions, and fingerprints. What it can't do is serialize a `next()`
   function — so code-shipped steps must be *executed where they live*
   (the API process, or the browser page) and only their *trace* shipped
   to the UI.
3. **The gap: nothing emits a trace today.** `read()`/`write()` are opaque.
   The one primitive to add to `@skew/core` is a dev-only trace hook.

That hook is also what makes this better than a GraphiQL clone: GraphiQL is
a sandbox; the interesting skew moments (a two-week-old draft migrating, an
outbox replay hitting `ahead`, a lossy down-write) happen inside a *running
app*. With a tap on real `read()` calls, Studio gets a **live feed** — 
Apollo-devtools-style — not just a scratchpad.

## The one new core primitive: the trace hook

React-devtools pattern — a global hook, dev-only, zero cost when absent:

```ts
// @skew/core, guarded so minifiers drop it in prod builds
interface SkewTraceEvent {
  kind: 'read' | 'write' | 'step' | 'result';
  schema: string;            // envelope name
  from?: number; to?: number;
  op?: LensOp;               // present for interpreted (contract) steps
  payloadBefore?: unknown;   // redactable, see Security
  payloadAfter?: unknown;
  result?: { ok: boolean; reason?: string; migratedFrom?: number | null;
             downgradedFrom?: number; lossyPaths?: string[]; derivedPaths?: string[] };
  source?: string;           // 'store:get' | 'resolver' | 'outbox' | 'manual'
  ts: number; traceId: string;
}
globalThis.__SKEW_DEVTOOLS_HOOK__?.emit(event)
```

Everything else in this plan is a consumer of this one event stream. The
same format serves: the sandbox step-through, the live feed, and the server
trace endpoint. `MigrationContext` (deterministic clock/seed) already makes
replays reproducible — Studio passes a fixed context so re-running a trace
gives identical output.

## Package layout

```
libs/
├── core/                     # + trace hook (tiny, dev-guarded)
├── studio/                   # @skew/studio
│   ├── src/lib/protocol.ts   # trace event + introspection wire types
│   ├── src/lib/introspect.ts # registry -> serializable catalog
│   ├── src/lib/explain.ts    # pure lens-op replayer with per-op diffs
│   ├── src/lib/handler.ts    # framework-agnostic HTTP handler (mount core)
│   ├── src/lib/express.ts    # skewStudio() -> express.Router
│   ├── src/lib/nest.ts       # SkewStudioModule.forRoot()
│   ├── src/lib/browser.ts    # mountSkewStudio() floating dev panel
│   └── ui/                   # the app itself (built to one self-contained
│                             #   studio.html — inlined JS/CSS, no CDN)
```

One UI bundle, compiled once, embedded as a string asset in the package.
Express and Nest mounts serve the same bytes; the browser mount injects the
same UI into an iframe/shadow-root panel. (Angular-specific niceties can
come later via `@skew/angular-*`; nothing here depends on Angular.)

## The three mounts

**Express** (dev-gated by default):

```ts
import { skewStudio } from '@skew/studio/express';
app.use('/__skew', skewStudio({ contracts: [FUND_CONTRACT] }));
```

**NestJS**:

```ts
SkewStudioModule.forRoot({ path: '__skew', contracts: [FUND_CONTRACT] })
```

Both expose, beside the UI:
- `GET /__skew/introspect` — registry catalog: schema names, version spans,
  step descriptions, fingerprints, which steps are lens-ops (fully
  replayable client-side) vs code (server-execution only), plus the
  contract documents themselves.
- `POST /__skew/trace` — `{ schema, payload, direction: 'read' | {as: n},
  context? }` → the full `SkewTraceEvent[]` for that run plus the final
  result. This is how code-shipped steps get visualized: executed in the
  process that owns them, traced, shipped back as data.

**Browser** — two layers:
- `mountSkewStudio()` in dev builds: floating panel, talks directly to the
  in-page registry and hook. No HTTP, no extension install. Sees *live*
  traffic: versioned-store reads, outbox replays, resolver cures.
- The global hook doubles as the attach point for a real Chrome-extension
  devtools panel later — same protocol, deferred until the embedded panel
  proves the UX (an extension is a packaging exercise, not a design one).

And the zero-install path that falls out of contract-documents-being-data:
a static `studio.html` (publishable to a docs site) with a URL box — point
it at any origin's well-known contract URL and explore/replay that
contract entirely client-side, CORS permitting. GraphiQL-parity for free.

## The UI (what "visually inspect up/down casts" means concretely)

Three tabs, GraphiQL-shaped layout (explorer left, work surface center,
inspector right):

1. **Explore** — schema/contract catalog: version lane per schema
   (v1 → v2 → v3), each step expandable to its ops or its code-step name,
   fingerprints, and computed `lossyPaths`/`derivedPaths` per direction.
2. **Cast** (the playground): paste JSON or a full envelope (or pick a
   sample generated from the contract's JSON Schema); choose read (up) or
   `write({as})` (down); see a **timeline of the payload at every
   version**, with per-op diffs — renamed keys linked, moved paths drawn
   across, defaulted fields marked derived (amber), dropped fields marked
   lossy (red, struck through). The final discriminated result is shown
   exactly as code receives it (`ok` / `reason` / `migratedFrom` /
   `downgradedFrom` / paths), because teaching the result contract is half
   the point. Failure staging: pick "read this v3 envelope with a build
   pinned at v1" and watch `ahead` happen, then click "cure via contract"
   to watch `readResolving` fix it.
3. **Live** — the hook feed: every real read/write in the running app (or
   API process, via SSE from the mount), filterable by schema/result,
   click any event to open it in the Cast tab and re-step it.

## Security posture

- Mounted only when `NODE_ENV !== 'production'` unless explicitly forced;
  forcing requires the host to supply its own auth middleware/guard.
- `POST /trace` executes *already-deployed migration code* on user-supplied
  JSON — same code paths the API runs on every request, no eval, no new
  execution surface. Still: rate-limit and size-cap the payload.
- Payload capture in the hook is opt-in per environment and supports a
  redaction function (drafts contain user data; the live feed must be able
  to show shapes without values).
- The UI bundle is fully self-contained (no CDN fetches), so it works in
  air-gapped/dev-container setups and adds no supply-chain surface.

## Phases

1. **Trace hook in `@skew/core` + protocol types in `@skew/studio`.**
   Smallest possible core change; unit tests assert zero behavior change
   and zero overhead when no hook is installed.
2. **`explain.ts` + Cast tab for contract/lens steps, fully client-side**,
   shipped as the static `studio.html` with the URL box. Immediately
   useful against the demo api's `portfolio-fund` contract; no server code
   yet.
3. **Server mounts** (`handler.ts` core, Express router, Nest module):
   introspect + trace + SSE feed; dogfood on `apps/api`.
4. **Browser panel** (`mountSkewStudio()`): live feed wired to the hook;
   dogfood on the `shell` demo app's versioned stores and outbox.
5. **Polish + docs**: sample-payload generation from JSON Schemas, trace
   permalinks (serialized trace in the URL hash for bug reports), README
   per mount, and a section in the `using-skew` agent skill.
6. *(Deferred)* Chrome extension packaging of the same panel; server-push
   of traces from remote environments.

## Decisions (settled 2026-08-10)

1. **Packaging**: one `@skew/studio` with subpath exports
   (`@skew/studio/express`, `@skew/studio/nest`, browser entry on the
   root). Versioning stays atomic; each mount is <200 lines over the
   shared handler.
2. **One interpreter**: `explain.ts` wraps `compileLens` per-op — the
   studio never reimplements op semantics, so explain-vs-runtime drift is
   structurally impossible. Only the hook is added to `@skew/core`; core
   stays dependency-free and studio stays deletable.
3. **No prod trace access**: the trace endpoint is dev-only, full stop.
   No signed "support mode" for now; revisit only if a live incident
   proves the need.
4. **Dogfooding on bulletin-app's Firebase Functions API is deferred** —
   phase 3 dogfoods on the workspace's own `apps/api` only.
