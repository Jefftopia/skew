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
  <img alt="189 tests passing" src="https://img.shields.io/badge/tests-189%20passing-2EA043?style=flat-square" />
  <img alt="zero core dependencies" src="https://img.shields.io/badge/core%20deps-0-8FBFE0?style=flat-square" />
  <img alt="MIT" src="https://img.shields.io/badge/license-MIT-1E3A5F?style=flat-square" />
</p>

<p align="center">
  <a href="#you-only-ever-see-the-fin">Why</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#packages">Packages</a> ·
  <a href="#skewcore">Core</a> ·
  <a href="#handling-version-skew-in-api-data--a-step-by-step-workflow">API workflow</a> ·
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
| **[`@skew/core`](libs/core)**                         | Envelopes, migration chains, build identity, skew detection. No dependencies, no framework. | **52 tests** |
| **[`@skew/angular-core`](libs/angular/core)**         | First-class Angular DI and Signal wrappers for `@skew/core`.                                | **0 tests**  |
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

### Runtime validation (Zod / Valibot)

Skew handles the envelope (`{ v, payload }`) and the migration chain, but it deliberately avoids shipping a payload validator so the core stays dependency-free. If you want to prove the payload actually matches the interface, bring your own validator (like Zod or Valibot) via the `validate` option. It runs *after* all migrations complete:

```ts
import { z } from 'zod';
import { versioned } from '@skew/core';

const WeeklyContentV3Schema = z.object({
  id: z.string(),
  scriptureOfWeek: z.string(),
  orderOfWorship: z.object({ setting: z.string(), hymns: z.array(z.string()) })
});

export const WeeklyContent = versioned<V1>('weekly-content', {
  validate: (val): val is V3 => WeeklyContentV3Schema.safeParse(val).success
})
  .next<V2>(/* ... */)
  .next<V3>(/* ... */);
```

If validation fails, `.read()` returns `reason: 'invalid'` rather than throwing, so you can still handle it cleanly at the boundary.

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

## Handling version skew in API responses — a step-by-step workflow

Everything above applies to data that outlives the code that wrote it, wherever it's stored. This is the same idea aimed at one specific boundary: a response body from an API your build didn't ship. 

**Why this matters in a federated app:** Suppose a Module Federation Host consumes v1 of a fund API, but a newly deployed Remote consumes v2. Both run on the same page. The user fetches data in the Host (v1), clicks a button that opens the Remote, and hands that cached data across the boundary. If the Remote blindly casts it with `as FundV2`, the app crashes when trying to render fields that don't exist. Skew catches this mismatch and forces the Remote to cleanly migrate or reject the payload.

Every step below is implemented and running in the [portfolio demo](#the-portfolio-demo--a-real-api-two-live-contract-versions) — the code snippets are lifted directly from `apps/api` and the `funds`/`orders` contracts in the Angular apps, not simplified for the README.

### Step 1 — Declare what you expect, not what you hope arrives

Every payload gets a schema, versioned from the shape you understand today:

```ts
// apps/prod-host/src/app/portfolio/contracts.ts
export interface FundV1 {
  id: string;
  name: string;
  currency: string;
  nav: number;
  cashPct: number;
  holdings: HoldingV1[];
}

export const FundListSchemaV1 = versioned<FundV1[]>('portfolio-funds');
```

The string `'portfolio-funds'` is the contract's name, not a variable name — it's how a reader on a different build, or a different app entirely, recognises this is the same envelope. Get it wrong and two sides silently stop talking to the same schema.

### Step 2 — Read every response through the schema, never through a cast

```ts
// apps/prod-host/src/app/portfolio/portfolio-page.ts
this.http.get(`${API_BASE}/v1/funds`).subscribe({
  next: (body) => {
    const result = FundListSchemaV1.read(body);
    if (!result.ok) {
      // see Step 3 — never fall through with `body as FundV1[]`
      return;
    }
    this.funds.set(result.value); // typed, migrated, current
  },
});
```

This is the one habit that matters more than any other line in this README: `.read(body)` where you were about to write `body as FundV1[]`. The cast compiles either way; only one of them tells you when it's wrong.

### Step 3 — Handle every failure reason, not just the happy path

```ts
if (!result.ok) {
  switch (result.reason) {
    case 'ahead':
      // the API is running a newer contract than this build knows —
      // refetch after a deploy, or tell the user to reload
      break;
    case 'gap':
      // your migration chain is missing a step; this is a bug, report it
      break;
    case 'invalid':
      // not this schema's data at all — a real 404 body, an error page, etc.
      break;
    case 'threw':
      // a migration step threw partway through — also a bug, report it
      break;
  }
}
```

`ahead` is the one worth sitting with. It means the server is newer than you are, which happens constantly and isn't a bug: a colleague's tab redeployed before yours, a phone updated before the laptop did. There is no shape to migrate _down_ to — the fields the newer contract added simply were never sent to you — so the honest move is to refuse and say so, not to guess.

### Step 4 — When the contract changes, extend the schema; never edit the base type

```ts
// apps/prod-remote/src/app/portfolio/contracts.ts
interface FundV1 {
  /* frozen — this is what v1 looked like, forever */
}

export const FundSchemaV2 = versioned<FundV1>('portfolio-fund').next<FundV2>('promote scalars to structure; add fields v1 never carried', (v1) => ({
  /* … */
}));
```

The migration closes over `FundV1` as a frozen snapshot, never over your current, editable interface. Import the live type into a migration and the moment someone edits it, every old migration starts lying about what it produces — silently, because TypeScript has no way to know a migration's _meaning_ changed, only that it still compiles.

If a v2 field has no honest v1-derived value, say so in the value itself — `0`, `'unknown'`, a tier that's a guess — rather than inventing something plausible. A guess that looks real is a guess nobody will ever go back and check.

### Step 5 — On the server: version the endpoint, don't mutate it in place

```ts
// apps/api/src/app/portfolio/funds-v1.controller.ts
@Controller('v1/funds')
export class FundsV1Controller {
  @Get()
  list() {
    return { v: 1, payload: funds };
  }
}

// apps/api/src/app/portfolio/funds-v2.controller.ts
@Controller('v2/funds')
export class FundsV2Controller {
  @Get()
  list() {
    return { v: 2, payload: funds.map(toFundV2) };
  }
}
```

Both routes are live at once, from the same process, off the same underlying data. That's what makes this a _mid-migration_ API rather than a big-bang cutover: a client pinned to v1 keeps working the entire time a client on v2 is already shipping. The envelope (`{ v, payload }`) is written by hand here, not through `@skew/core` — the server is a separate deployment from every consumer, on its own release cycle, and shouldn't share code with any of them. The envelope shape is the contract; a library is just one implementation of reading it.

### Step 6 — On writes: refuse a stale contract, don't coerce it

```ts
// apps/api/src/app/portfolio/orders.controller.ts
@Post()
create(@Body() body: { v: number; payload: unknown }) {
  if (body.v !== 2) {
    throw new ConflictException({
      error: 'version-skew',
      expected: 2,
      received: body.v,
      message: `Order was authored against contract v${body.v}; this endpoint requires v2.`,
    });
  }
  // …
}
```

The tempting alternative — detect `v: 1`, upgrade it server-side, accept it anyway — turns a real disagreement into a false success. The client sent something it built under an assumption that's now wrong; the server is the only party that knows the assumption is wrong, and staying quiet about it means the client never finds out. A `409` with a named reason is the whole fix. Whether the client can _do_ anything about it is Step 7.

### Step 7 — If a write can be queued (offline, retried, or across a redeploy), route it through the outbox

```ts
// apps/prod-remote/src/app/portfolio/order-outbox.ts
async function runOrderMutation(input: unknown, entry: OutboxEntry): Promise<unknown> {
  const envelope = entry.schemaVersion === 2 ? OrderSchemaV2.write(input as OrderV2) : { v: entry.schemaVersion, payload: input };

  const first = await postOrder(envelope);
  if (first.status !== 409) return first.body; // (error handling omitted)

  // Refused for skew — migrate the queued payload ourselves and retry once.
  const migrated = OrderSchemaV2.read(envelope);
  const retry = await postOrder(OrderSchemaV2.write(migrated.value));
  return retry.body;
}
```

Two things have to be true for this to work, and both are easy to get wrong:

1. **The retry happens inside the runner, in the same call.** `@skew/angular-data`'s outbox re-runs a failed entry with the exact same input on its next flush — retrying at the library level would just resend the same stale envelope and get the same `409` forever. Migrating has to happen before the runner returns.
2. **The queued entry carries the contract version it was written under** (`OutboxEntry.schemaVersion`), so a mutation can be migrated correctly no matter how long it sat queued or how many deploys happened while it waited.

### Step 8 — Prove the failure you're preventing actually exists

Every step above is a claim about what would go wrong without it. Don't take the claim on faith — this repo ships an undocumented kill switch (`setSkewDisabled()` / `provideSkewDisabled()`, in [`libs/core/src/lib/disabled.ts`](libs/core/src/lib/disabled.ts)) specifically so you can turn every protection off and watch the same code fail on its own merits: envelopes stop being written, `.read()` stops checking versions, migrations stop running. It is exported but not part of the public API — no legitimate reason to ship it — and exists only so a before/after comparison has an actual "before" to look at instead of a hypothetical one. The Basics tab of the production demo (below) has a switch wired to it; flipping it and re-running any scenario is the fastest way to convince yourself — or a reviewer — that a step here is load-bearing rather than decorative.

---

## Angular Integrations

Skew provides first-class bindings for the Angular ecosystem, bridging the gap between `@skew/core`'s framework-agnostic primitives and Angular's reactivity (Signals) and Dependency Injection systems.

- **[`@skew/angular-core`](libs/angular/core/README.md)**: The standard DI and Signal wrappers for safely injecting and consuming versioned stores in Angular without UI flicker.
- **[`@skew/angular-router`](libs/angular/router/README.md)**: Chunk recovery for lazy-loaded routes. Intelligently catches `ChunkLoadError`s, compares build manifests to prevent infinite loops, and recovers gracefully without losing unsaved work.
- **[`@skew/angular-data`](libs/angular/data/README.md)**: A normalized entity store with tag invalidation and a durable mutation outbox, solving the problem of `resource()` acting as a per-call cache.
- **[`@skew/angular-workflow`](libs/angular/workflow/README.md)**: Durable multi-step flows that survive page refreshes, deployments, and device swaps.

For a comprehensive guide on integrating Skew into your Angular application, see the **[Angular Integrations Hub](libs/angular/README.md)**.

---

## Why not just…

**…`location.reload()` on `ChunkLoadError`?** That's the naïve branch above. It works until the origin is stale (infinite loop), the user is offline (error page), the route was deleted (404), or somebody had a half-written form open (data loss).

**…let CDN caching keep old chunks alive?** Caching isn't retention. Edges evict on LRU regardless of TTL, and cold edges never had the object — both go to origin, and if your pipeline ran `s3 sync --delete` or rolled a container, it's gone. The CDN converts a deterministic failure into an intermittent, region-dependent one, which is _worse_ to debug. Retention is the real mitigation; if you have it, you need less of this.

**…Vercel Skew Protection?** Excellent, and it solves the asset half at the platform layer. Unavailable on Kubernetes, internal nginx, IIS, or on-prem — which is most enterprise Angular. And it doesn't touch API contract skew, the more dangerous half.

**…a state library for drafts?** They store state; they don't _version_ it. The failure here isn't losing the draft — it's resuming a draft whose shape has since changed.

---

## Demos

There are two. They answer different questions, and the difference matters.

|                 | `apps/shell`                        | `apps/prod-host` + `apps/prod-remote`             |
| --------------- | ----------------------------------- | ------------------------------------------------- |
| Question        | _what does each failure look like?_ | _does this survive a real deploy?_                |
| "the other app" | a lazy route in the same build      | a separately built, separately served application |
| Failures        | simulated by toggles                | provoked by actually redeploying                  |
| Bundles         | one dev build                       | two production builds                             |
| Run it          | `npm run demo`                      | `npm run demo:prod`                               |

The first is faster to explore and can't tell you whether any of this works. The second can.

---

### The simulated demo — `apps/shell`

```sh
npm run demo            # dev server on :4200
npm run demo:build
```

One application pretending to be two. "App 2" is a lazy route in the same bundle, and a `Simulator` service fakes the deploy: purge the next chunk, point the version probe at a stale manifest, write a record as if the other build had written it.

Use the toggles at the top of the page, then load App 2. Everything the library decides is real; only the _provocation_ is faked — which is the point, because otherwise every one of these failures needs an actual deployment to reproduce.

---

### The production demo — `apps/prod-host` + `apps/prod-remote`

Two Angular applications, built by separate invocations, stamped with separate build identities, served from separate origins, and joined only at runtime.

Wired with **[Native Federation](https://www.npmjs.com/package/@angular-architects/native-federation)** — the Module Federation mental model (host, remote, `remoteEntry.json`, shared singletons) implemented on browser-native import maps. That's what works with Angular's esbuild application builder; Nx's own Angular Module Federation support is deprecated as of Nx 23 and points here.

**Nothing in this demo is simulated.** The remote's exposed module is content-hashed. Redeploying the remote deletes the file name a running tab is holding, and the 404 that follows is the same 404 your users get.

#### What's in it

|                         |                                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------ |
| `apps/prod-host`        | The **older** deployment. Draft schema v1, wizard 0.1. Knows the remote only as a URL.           |
| `apps/prod-remote`      | The **newer** deployment. Draft schema v2, wizard 0.2. Exposes `./Editor`; also runs standalone. |
| `tools/deploy-demo.mjs` | Stamps identity → builds → emits the manifest. One identity in all three places.                 |

Worth noting what the two apps **don't** share: `domain.ts` is duplicated on purpose. A shared library would make them one deployment and delete the problem the demo exists to show. What they actually share is the envelope on disk — `{ v, data }` — and `@skew/core` reconciles them there.

What they _do_ share, via `sharedMappings` in `federation.config.mjs`, is the `@skew/*` runtime itself — one instance, one set of injection tokens, across both bundles. Anything DI-shaped that crossed the boundary would need this; without it a host's `provideSkewWorkflow` writes to a different `InjectionToken` than the one a remote's `injectWorkflow` reads, and you get a "no provider" error that points nowhere useful.

The exposed component nonetheless takes **no** DI dependency on the host, and that's the sharper lesson. It reads and writes persisted envelopes instead. A remote that needs the host to have configured the right providers is a remote coupled to a build it can't see.

#### Running it

```sh
npm run demo:prod
```

That builds and deploys both, then serves them:

- **host** → <http://localhost:4410> ← start here
- **remote** → <http://localhost:4411> — the same editor, standalone

For the deploy scenarios you want two terminals: one holding the servers, one to redeploy from. Scenarios 1 and 2 route through the Portfolio tab's fund detail page, which needs the API too — a third terminal, `npm run api`.

```sh
# terminal 1 — leave this running
npm run demo:prod:build && npm run demo:prod:serve

# terminal 2 — used during the scenarios below
npm run demo:prod:redeploy-remote

# terminal 3 — only needed for scenarios 1 and 2
npm run api
```

| Script                      | What it does                                                      |
| --------------------------- | ----------------------------------------------------------------- |
| `demo:prod`                 | Build + deploy both, then serve both                              |
| `demo:prod:build`           | Deploy remote, then host — no serving                             |
| `demo:prod:serve`           | Serve both from `dist/`, no rebuild                               |
| `demo:prod:redeploy-remote` | **The interesting one.** New build id, new hashes, old files gone |
| `demo:prod:deploy-host`     | Same, for the host                                                |
| `demo:prod:same-origin`     | The same two builds on **one** origin — see below                 |
| `demo:prod:dev`             | Both under dev servers with HMR, for editing the demo itself      |

#### Two origins or one

Two ports means two **origins**, and the Same-Origin Policy then partitions `localStorage` — so the remote opened on its own at `:4411` sees an empty bucket. That is honest about what two ports mean, and it is not how any of this gets deployed.

```sh
npm run demo:prod:same-origin      # everything on http://localhost:4420
```

- **host** → <http://localhost:4420/>
- **remote** → <http://localhost:4420/remote/>

Same two build artifacts, unchanged, mounted at different paths behind one server (`tools/serve-same-origin.mjs`, Node builtins only). This is what a reverse proxy in front of a host and its remotes actually looks like, and it is the mode to reach for if you're using the demo as a template.

|                                          | two ports                 | one origin |
| ---------------------------------------- | ------------------------- | ---------- |
| Federation                               | works                     | works      |
| Deploy skew, rollback, schema skew       | all work                  | all work   |
| Standalone remote reads the host's draft | **no** — different origin | **yes**    |
| Matches production                       | rarely                    | usually    |

Nothing about federation wants separate origins. The host resolves the remote by URL, and a relative URL is a URL — the manifest just says `/remote/remoteEntry.json`. **The two builds stay independently deployable either way**; `demo:prod:redeploy-remote` still purges the old chunk and still triggers recovery, on either server.

Three details make one artifact work at both mount points, all of them things a real proxy does:

- **The manifest is served, not baked.** The host's bundle ships a manifest pointing at `:4411`; the same-origin server returns `/remote/remoteEntry.json` for `/federation.manifest.json` instead. Same bundle, different deployment, different remote URL — which is precisely why Native Federation reads it at runtime rather than compiling remote locations in.
- **The remote's `<base href>` is rewritten** from `/` to `/remote/` on the way out, so its relative assets and its own `initFederation('./remoteEntry.json')` resolve under the mount. The alternative is rebuilding with `--base-href /remote/`, which yields a bundle that _only_ works there.
- **`Cache-Control: no-store`**, or the redeploy scenarios quietly stop reproducing.

Each deploy increments a build number (`prod-remote-1`, `-2`, …) kept in `tmp/skew-demo/`, so successive runs are genuinely different deployments rather than identical rebuilds.

---

### Seeing what you're protected from

Every card names what it exercises, what that buys you, and what it costs to go without:

> **TESTS** `read()` returning `ahead`
> **ENABLES** A typed refusal at the boundary, with the data left intact
> **WITHOUT IT** `TypeError` deep in a renderer, far from the cause

The third line is not a claim you have to take on trust. There is a **protections switch** at the top of the host, and turning it off does not put `@skew` into a "pretend to fail" mode — it makes the packages **inert**. Envelopes stop being written, migrations stop running, `lazy()` stops retrying, recovery stops classifying. Re-run any scenario and the plain code you would have written instead runs in its place, and fails on its own merits.

The **Basics** tab is built around this. The host is on the left, the remote is in a permanently-open drawer on the right, and a four-step walkthrough runs a single record's round trip across both — write it as v1, read it as v2, write it as v2, then watch the host refuse it. Steps 2 and 3 execute _inside the remote_; the host dispatches them over a DOM event channel (`bridge.ts` ↔ `commands.ts`) rather than asking you to go find a button in the other pane. Both halves of every comparison are on screen at once, which they were not when the remote lived on its own route.

Above the steps, the **Boundary Inspector** redraws after each one:

```text
┌──────────────────────┐              ┌──────────────────────┐
│ HOST — OLDER BUILD   │   ┌───────┐  │ REMOTE — NEWER BUILD │
│ prod-host-21         │──▶│ v: 1  │─▶│ prod-remote-31       │
│ understands v1       │   └───────┘  │ understands v2       │
└──────────────────────┘              └──────────────────────┘

  ✓  Migrated v1 → v2

  FIELD    BEFORE                    AFTER
  id       "demo-1"                  "demo-1"                    SAME
  author   "Rev. Bernard J. Miller"  {"name":"Rev. …","email":""} MIGRATED
  summary  —                         "Prepare the way of the …"  DERIVED
```

That last row is the reason this replaced a scrolling log. "It migrated" is not one fact — `author` came from somewhere real, `summary` did not. A **derived** value is the migration's best guess from a shape that never carried the field, and anything downstream treating it as a reported value is trusting a guess. A log line saying `migrated v1→v2` is accurate and hides exactly that.

Flip the protections off and run step 4 again: the read _succeeds_, hands back a shape this build cannot use, and the ordinary `draft.author.toUpperCase()` that follows throws `Cannot read properties of undefined`. The inspector shows the same two fields as **LOST**. That is the whole argument for envelopes, in two clicks.

The switch is `provideSkewDisabled()` / `setSkewDisabled()`. It is **exported but deliberately undocumented** — no legitimate production use, and the failures it re-enables are the silent kind. It exists because a before/after that only ever runs the "after" is not a comparison. The source explains itself; `libs/core/src/lib/disabled.ts` is the place to start.

There is still a plain chronological record — an **Activity** disclosure, collapsed, at the top of the page. It is closed by default on purpose: "show me everything in order" is a real need when something misbehaves, and a bad first thing to put in front of someone who is trying to understand a concept.

---

### The scenarios

#### 1 · A deploy lands under a live user

The one everybody has hit and nobody can reproduce. This is the Portfolio tab's story now, not Basics' — see the note at the end of this scenario for why.

1. `npm run api`, then open <http://localhost:4410/portfolio> and **click into any fund** — you need to be on a `/portfolio/fund/:id` URL, not the list.
2. In another terminal: `npm run demo:prod:redeploy-remote`
3. Navigate to a **different** fund from the fund list — **without reloading**.

**What you should see.** A brief pause, then that fund's detail, on the _new_ remote build, at the URL `/portfolio/fund/<id>`.

**What actually happened.** Native Federation resolved `remoteEntry.json` once, at page load, and cached the hashed file names in an import map. The redeploy deleted those files. So:

```
import rejects (real 404)
   │
   ├─ lazy() retries once ──── a cold CDN edge and a purged asset are
   │                           indistinguishable from the error alone
   └─ still failing → probe the origin
                        ├─ online?          yes
                        ├─ origin older?    no — it's newer
                        ├─ budget spent?    no
                        ├─ unsaved work?    no
                        └─ → reload at the TARGET url
```

The last line is the part worth watching. Angular's `urlUpdateStrategy` defaults to `'deferred'`, so when that navigation failed the address bar still said the previous fund's URL. A plain `location.reload()` would have dropped you back there and silently swallowed the click. You land on the fund you actually asked for.

Check the two build ids (host's in the header, remote's in the fund-detail banner) afterwards — the host is unchanged, the remote moved.

> **Why this moved off the Basics tab.** Basics' federation card ("4 · Load the remote — no route") loads the remote's `Editor` inline, with no route at all. `SkewRecoveryService` only ever sees a failure through `NavigationError`, so it has nothing to react to when nothing is being navigated to. Fund detail is a real page at a real URL, so it's where the full recovery story — retry, classify, reload at the _correct_ place — still lives.

#### 2 · The origin is behind you

Same failure. Opposite decision.

1. Open <http://localhost:4410/?origin=rollback> — the header will say _probing the ROLLBACK manifest_. Click into a fund.
2. `npm run demo:prod:redeploy-remote`
3. Navigate to a different fund.

**What you should see.** No reload. A banner: _"Couldn't load the remote — recovery was withheld on purpose"_, explaining that the origin is serving an older build, with a **Reload anyway** button.

**Why.** The probe now fetches `skew-manifest-rollback.json` — a real artifact describing a real earlier deployment, which `tools/deploy-demo.mjs` emits alongside the current one. It is what an origin actually serves when a CDN is still holding a pre-deploy entry document, or when a rollback has reached some nodes but not others.

Reloading would fetch the same stale bundle, fail identically, and reload again. Forever. That's a bricked tab, so it stops and hands the decision to the user. Timestamps are what make this knowable — hence `builtAt` in the manifest.

#### 3 · Reading data an older build wrote

1. On the host: **Write v1 record**.
2. In the embedded remote below (Basics loads it automatically — no click) → **Read record as v2**.

**What you should see.** _Migrated v1 → v2_, and the migrated record printed: the bare `author` string is now `{ name, email }`, and `summary` was derived from the body.

The host had no idea a migration would ever be needed. It wrote an envelope that names its version; the remote declared the chain that gets from there to here.

#### 4 · Reading data a _newer_ build wrote

1. In the remote editor: **Write v2 record**.
2. Go back to the host → **Read record as v1**.

**What you should see.** _Refused — ahead_. Not a crash, not a half-populated object — a typed failure at the boundary.

This is the case most codebases get wrong, because the alternative looks harmless:

```ts
return JSON.parse(raw) as Draft; // an assertion, not a check
```

Data from the future can't be migrated downward — the information isn't there. Collapsing that into `null` means every caller guesses, and the guess is always "discard it". Instead you get `reason: 'ahead'` with `found` and `expected`, and you decide.

It happens more than you'd expect: a colleague saves from the new deploy while your tab is stale; a phone updates before the laptop does.

#### 5 · A workflow that grew a step

1. On the host, type a **title** and a **body** into **Start a wizard on 0.1** — two steps, no review. Watch the draft state go `idle` → `saving` → `saved`.
2. In the embedded remote below, click **Read the parked draft**.

**What you should see.** `Parked on "details" · payload migrated v1 → v2`, and the payload printed with a `summary` field the host never wrote.

Two schemas unwrap in order, and keeping them separate is the point. The **run envelope** — which step, which run, when — belongs to the library and evolves on its schedule. The **payload** belongs to you. Versioning them together would make a library upgrade invalidate every user's draft.

A draft written by one build and resumed under another is the same failure as a client calling a mismatched server. The counterparty is just your own past deployment.

> **Why the editor reads the draft rather than calling `injectWorkflow`.**
> `WorkflowRuntime.attach()` deduplicates by workflow **id**, so two components binding the same flow share one run instead of racing each other's drafts. Correct inside one build — and across a federation boundary it means **first attach wins**. Both builds here declare `skew-demo-wizard` and share one runtime, so the host's page attaches 0.1 before you ever reach the remote. Calling `injectWorkflow(wizardV2)` would silently hand back the host's 0.1 run: no `review` step, payload never migrated. Reading the draft is what this build does on any load where it's the only one running. Worth knowing before you expose a workflow from a remote.

#### 6 · The remote is a whole application

Open the remote directly — <http://localhost:4411> on two ports, or <http://localhost:4420/remote/> on one origin. The same `Editor` renders, and the banner says _running standalone_ rather than _fetched at runtime from a separate deployment_.

A remote that only works when embedded is a remote nobody can debug.

**On two ports the drafts are empty there, and that's correct.** `localStorage` is partitioned by origin, and the port is part of the origin — `:4410` and `:4411` are two different origins that happen to share a hostname. No CORS header or configuration bridges them; it's the Same-Origin Policy, and storage is one of the things it isolates absolutely. The card says so rather than showing you a blank form and letting you guess.

**On one origin the same page reads the host's draft**, migrated v1 → v2. Nothing in either build changed — only where they were mounted.

Two footnotes worth carrying away:

- **Cookies do _not_ follow this rule.** Cookie scope is domain + path; the port isn't in it. A cookie set at `:4410` is readable at `:4411` while `localStorage` stays sealed — two storage mechanisms on the same page with two different isolation rules, which is a reliable source of confusion on localhost.
- **Code runs with the origin of the page that loaded it, not the URL it came from.** The remote's module is fetched from `:4411` but evaluated inside the host's document, so it sees the host's storage and cookies. That's the same rule that lets a `<script src="cdn.example.com/…">` read your session cookie — fetching code from elsewhere doesn't sandbox it, it grants it your origin. Worth remembering when choosing whose remotes to load.

If you need state across genuinely separate origins, the channels are `postMessage` or a server — not storage. `BroadcastChannel` and the `storage` event look like candidates and are both same-origin only.

---

### Resetting between runs

Two pieces of state deliberately survive things you'd expect to clear them:

```js
// in the console, on http://localhost:4410
localStorage.clear(); // the v1/v2 draft and the wizard run
sessionStorage.clear(); // the recovery budget, the activity record, and the protection mode
```

**The protection mode persists too**, in `sessionStorage`, and is applied before Angular boots. It has to be: a recovery in scenario 1 or 2 reloads the page, and a mode that reset on reload would flip the protections back on mid-scenario — leaving you in the protected build trying to observe the unprotected one.

**The recovery budget is the one that will confuse you.** `maxRecoveries` defaults to 1 per build, and the counter lives in `sessionStorage` precisely so it survives the reload it is counting — that's what stops the loop in scenario 2. But it means a _second_ run of scenario 1 in the same tab reports `exhausted` instead of recovering. That's correct behaviour, and it looks like a bug.

Deploying the host again (`npm run demo:prod:deploy-host`) also clears it: the budget is keyed by build id, so a genuinely new build gets a fresh one.

### Which library does what here

| Scenario | Package                      | Covering tests                                                                                                                                                                                            |
| -------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1, 2     | `@skew/angular-router`       | `recovery.service.spec.ts` — _"reloads at the attempted URL, not the current one"_, _"does not reload when the origin is older than us — that would loop"_, _"persists across the reload it is counting"_ |
| 1        | `@skew/angular-router`       | `lazy.spec.ts` — retry and attribution                                                                                                                                                                    |
| 3, 4     | `@skew/core`                 | `versioned.spec.ts` — _"refuses to migrate data from a newer build rather than silently dropping fields"_; `storage.spec.ts`                                                                              |
| 1, 2     | `@skew/core` + `@skew/build` | `identity.spec.ts` — _"reports a stale origin when the origin is older — the reload-loop case"_; `stamp.spec.ts`                                                                                          |
| 5        | `@skew/angular-workflow`     | `engine.spec.ts`, `workflow.spec.ts`                                                                                                                                                                      |
| all, off | the protections switch       | `disabled.spec.ts` — asserts the failure modes it re-enables                                                                                                                                              |

The demo is the integration test you can watch; those are the ones CI runs.

That last row matters more than it looks. The switch is undocumented but not untested: if disabling ever stopped genuinely breaking things, every before/after above would quietly become theatre — the one outcome worse than not having the switch at all. So the tests assert the _damage_: a bare payload with no version recorded, a newer record handed back as though current, a migration skipped and the old shape kept.

### Adapting it to your own app

The demo is deliberately small enough to read end to end. The four files that matter:

| File                                    | What to copy                                                           |
| --------------------------------------- | ---------------------------------------------------------------------- |
| `apps/prod-host/src/app/app.config.ts`  | `provideSkewRecovery` with a stamped identity and a manifest URL       |
| `apps/prod-host/src/app/load-remote.ts` | Wrapping `loadRemoteModule` in `lazy()` so failures carry a logical id |
| `apps/prod-host/src/app/domain.ts`      | Declaring your current shape as the base version                       |
| `tools/deploy-demo.mjs`                 | The three-step stamp → build → manifest pipeline                       |

The adoption rule holds here too: take one package, take three, take none of the Angular ones. Nothing is load-bearing for anything else.

### The portfolio demo — a real API, two live contract versions

Behind a second tab (**Portfolio**, next to **Basics**) is a mock investment-management backend and a matching pair of federated screens, built to demonstrate one thing the chunk/draft/wizard scenarios above don't: **skew at the API boundary**, not just the storage or federation one.

```sh
npm run api              # NestJS, port 3333
npm run demo:prod        # or demo:prod:same-origin — either works
```

`apps/api` is a small NestJS app serving mock funds, holdings, a liquidity-breach SSE stream, and a live price WebSocket — nothing persisted beyond memory, restart it to reset. It serves **two live versions of the same fund contract at once**, `/api/v1/funds` and `/api/v2/funds`, the way a real API does mid-migration: v1 is what the host still understands (scalar `nav`, scalar `currency`), v2 is what the remote understands (`nav` promoted to `{ amount, asOf }`, plus `liquidity` and `classification` fields v1 never had).

**On the Portfolio tab (host):** a fund list pinned to v1 on purpose — expand a row to browse its holdings inline, or open one to bring up the remote beside it. Above the list, a **ticker typeahead**: search the tradeable universe (`GET /api/v1/tickers`), pin a symbol with the keyboard or the mouse, and the strip narrows to it while a drill-down card shows which funds hold it and what this tick did to each one's NAV. Every ticker is offered for every fund — mandate eligibility is realistic and would bury the part that teaches something.

The strip itself is a plain `WebSocket` (`ws://…/ws/ticker`, ~1 tick/sec) owned by `PortfolioLive`, provided once on the `portfolio` route rather than by either page under it — which is what lets it keep running while you open, switch, and close funds. An SSE listener (`EventSource` on `/api/events/liquidity`) for randomly-timed liquidity breaches — no sooner than 3s apart, no later than 15s — pushes a toast in the corner the instant one arrives; `POST /api/events/liquidity/trigger` fires one on demand.

**Clicking a fund** hands its v1 record to the remote via `sessionStorage` — the same mechanism `Editor` already uses — and navigates to `/portfolio/fund/:id`, resolved to the remote's `./FundDetail`. That route renders into an outlet _inside a drawer beside the fund list_, not over it: the list never disappears, picking a different fund swaps the drawer's context in place (same component, new route param), and the × closes it back to `/portfolio`.

**`FundDetail` is the centrepiece.** It shows three views of the same fund side by side: the record **handed over** (migrated forward from the host's v1, with every field the migration had to guess — `hqlaPct`, `liquidityTier`, `classification` — visibly badged `derived`); the **authoritative** record (`GET /api/v2/funds/:id`, read through the same v2 schema, real numbers); and where they **differ**. The migration isn't wrong to guess — it's the best answer available from v1 data — but the diff is where that becomes visible instead of silently wrong. It also opens its own ticker and SSE connections: a price move touching this fund surfaces as a banner offering a refresh — never a silent rewrite of what's on screen — and a breach naming this fund pre-fills an order form from the suggested remediation.

**Submitting the order is the fourth boundary** the top-level table (`§ You only ever see the fin`) names but the rest of the demo doesn't cover: _client ↔ API_. The order goes through the `@skew/angular-data` outbox, so it survives a reload, and `/api/v2/orders` genuinely refuses a v1-shaped order with `409 version-skew` — there's a **"queue as v1"** button that deliberately triggers this, so you can watch the outbox runner catch the 409, migrate the queued payload with the remote's own `OrderSchemaV2`, and retry, rather than only seeing it work.

Full build-out — every phase, checkpoint, and design decision — is in [`docs/portfolio-demo-plan.md`](docs/portfolio-demo-plan.md), written as a step-by-step spec for another agent to execute; this repo's `apps/api` and the `portfolio/` folders in both Angular apps are the result of following it.

### If something doesn't work

**The ports are in use.** The demo runs on 4410/4411 (two-origin) and 4420 (one-origin) to stay clear of the usual 4200. For the two-origin mode, changing them means changing four places together: `serve-dist` (and `serve-original`, for `demo:prod:dev`) in each app's `project.json`, and `apps/prod-host/public/federation.manifest.json`, which is the URL the host actually resolves at runtime. The one-origin server takes `--port` and needs no other change — it synthesizes its own manifest:

```sh
node tools/serve-same-origin.mjs --port 5000
```

**Scenario 1 just works, with no pause.** You reloaded after redeploying. A fresh page load fetches the new `remoteEntry.json` and there's nothing stale left to fail. The sequence has to be: load → redeploy → click.

**Scenario 1 reports `exhausted`.** The recovery budget is spent for this build in this tab. See above.

**The editor never loads, in any scenario.** Check the remote is actually up: `curl http://localhost:4411/remoteEntry.json` (or `curl http://localhost:4420/remote/remoteEntry.json`). In the two-origin mode the host fetches it cross-origin, so the static server must send CORS headers — `serve-dist` sets `cors: true`. The one-origin mode needs no CORS at all, which is one fewer thing to get wrong.

**`demo:prod:serve` prints "Waiting for … in another nx process" and exits immediately.** Nx dedupes continuous targets across concurrent invocations, and a server killed abruptly can leave that lock behind — the new run then attaches to a process that is no longer there and reports success while serving nothing. Both ports will refuse connections.

```sh
npx nx reset
npm run demo:prod:serve
```

Redeploying from a second terminal while the servers run is fine — that's a different target, and the servers survive it. This only bites after a hard kill.

**The Portfolio tab shows "Could not reach the portfolio API."** `npm run api` is a separate process from the Angular servers — nothing starts it for you. Confirm with `curl http://localhost:3333/api/v1/funds`.

**Same-origin mode (`:4420`) proxies `/api/*` and `/ws/ticker`, but does not start the API itself.** `tools/serve-same-origin.mjs` forwards to `:3333`; `npm run api` still has to be running separately, in its own terminal.

---

## Development

```sh
npm install
npm run verify                   # lint + test + build, every library

npm test                         # all projects
npm run test:libs                # libraries only
npm run test:core                # 52 · also :build-tools :angular-router :angular-data :angular-workflow

npm run build:libs               # → dist/libs/*
npm run lint:libs
npm run format
```

**Publishing**

```sh
npm run deploy:libs:dry-run
npm run deploy:libs              # nx release publish

npm run registry                 # verdaccio on :4873
npm run deploy:libs:local        # publish there instead
```

**Workspace conventions**

- Strict TypeScript with `noUncheckedIndexedAccess`
- ESM with explicit `.js` specifiers, enforced by `moduleResolution: nodenext` — added after a packaging bug that passed both `tsc` _and_ `nx build` and would still have broken every consumer at runtime
- Angular: signals, zoneless, standalone-only, `inject()`, no NgModules, `provide*` returning `EnvironmentProviders`
- Results over exceptions at every boundary
- Zero runtime dependencies outside peer frameworks

Design rationale for every package — including the constraints that forced each API shape and the known gaps with their workarounds — lives in the **[Technical Appendix](technical-appendix.md)**.

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
