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

For the deploy scenarios you want two terminals: one holding the servers, one to redeploy from.

```sh
# terminal 1 — leave this running
npm run demo:prod:build && npm run demo:prod:serve

# terminal 2 — used during the scenarios below
npm run demo:prod:redeploy-remote
```

| Script                      | What it does                                                      |
| --------------------------- | ----------------------------------------------------------------- |
| `demo:prod`                 | Build + deploy both, then serve both                              |
| `demo:prod:build`           | Deploy remote, then host — no serving                             |
| `demo:prod:serve`           | Serve both from `dist/`, no rebuild                               |
| `demo:prod:redeploy-remote` | **The interesting one.** New build id, new hashes, old files gone |
| `demo:prod:deploy-host`     | Same, for the host                                                |
| `demo:prod:dev`             | Both under dev servers with HMR, for editing the demo itself      |

Each deploy increments a build number (`prod-remote-1`, `-2`, …) kept in `tmp/skew-demo/`, so successive runs are genuinely different deployments rather than identical rebuilds.

---

### The scenarios

#### 1 · A deploy lands under a live user

The one everybody has hit and nobody can reproduce.

1. Open <http://localhost:4410> and **leave the tab alone**.
2. In the other terminal: `npm run demo:prod:redeploy-remote`
3. Back in the tab, click **Open the remote editor** — **without reloading**.

**What you should see.** A brief pause, then the editor, on the _new_ build, at the URL `/editor`.

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

The last line is the part worth watching. Angular's `urlUpdateStrategy` defaults to `'deferred'`, so when that navigation failed the address bar still said `/`. A plain `location.reload()` would have dropped you back on the home page and silently swallowed the click. You land on `/editor`.

Check the two build ids in the header afterwards — the host is unchanged, the remote moved.

#### 2 · The origin is behind you

Same failure. Opposite decision.

1. Open <http://localhost:4410/?origin=rollback> — the header will say _probing the ROLLBACK manifest_.
2. `npm run demo:prod:redeploy-remote`
3. Click **Open the remote editor**.

**What you should see.** No reload. A banner: _"Couldn't load the remote — recovery was withheld on purpose"_, explaining that the origin is serving an older build, with a **Reload anyway** button.

**Why.** The probe now fetches `skew-manifest-rollback.json` — a real artifact describing a real earlier deployment, which `tools/deploy-demo.mjs` emits alongside the current one. It is what an origin actually serves when a CDN is still holding a pre-deploy entry document, or when a rollback has reached some nodes but not others.

Reloading would fetch the same stale bundle, fail identically, and reload again. Forever. That's a bricked tab, so it stops and hands the decision to the user. Timestamps are what make this knowable — hence `builtAt` in the manifest.

#### 3 · Reading data an older build wrote

1. On the host: **Write v1 record**.
2. **Open the remote editor** → **Read record as v2**.

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
2. Open the remote editor and click **Read the parked draft**.

**What you should see.** `Parked on "details" · payload migrated v1 → v2`, and the payload printed with a `summary` field the host never wrote.

Two schemas unwrap in order, and keeping them separate is the point. The **run envelope** — which step, which run, when — belongs to the library and evolves on its schedule. The **payload** belongs to you. Versioning them together would make a library upgrade invalidate every user's draft.

A draft written by one build and resumed under another is the same failure as a client calling a mismatched server. The counterparty is just your own past deployment.

> **Why the editor reads the draft rather than calling `injectWorkflow`.**
> `WorkflowRuntime.attach()` deduplicates by workflow **id**, so two components binding the same flow share one run instead of racing each other's drafts. Correct inside one build — and across a federation boundary it means **first attach wins**. Both builds here declare `skew-demo-wizard` and share one runtime, so the host's page attaches 0.1 before you ever reach the remote. Calling `injectWorkflow(wizardV2)` would silently hand back the host's 0.1 run: no `review` step, payload never migrated. Reading the draft is what this build does on any load where it's the only one running. Worth knowing before you expose a workflow from a remote.

#### 6 · The remote is a whole application

Open <http://localhost:4411> directly. The same `Editor` renders, and the banner says _running standalone_ rather than _fetched at runtime from a separate origin_ — it checks `import.meta.url` against `location.origin`.

A remote that only works when embedded is a remote nobody can debug.

**The drafts are empty there, and that's correct.** `localStorage` is partitioned by origin, and `:4410` and `:4411` are different origins. When the host loads the remote, the remote's code runs _inside the host's page_, so it sees the host's storage; opened on its own it gets its own, empty bucket. The card says so rather than showing you a blank form and letting you guess.

That partitioning is the honest version of the boundary: a real host and remote usually _do_ share an origin behind a reverse proxy, and if yours don't, storage is not the channel to pass state through.

---

### Resetting between runs

Two pieces of state deliberately survive things you'd expect to clear them:

```js
// in the console, on http://localhost:4410
localStorage.clear(); // the v1/v2 draft and the wizard run
sessionStorage.clear(); // the recovery budget
```

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

The demo is the integration test you can watch; those are the ones CI runs.

### Adapting it to your own app

The demo is deliberately small enough to read end to end. The four files that matter:

| File                                    | What to copy                                                           |
| --------------------------------------- | ---------------------------------------------------------------------- |
| `apps/prod-host/src/app/app.config.ts`  | `provideSkewRecovery` with a stamped identity and a manifest URL       |
| `apps/prod-host/src/app/load-remote.ts` | Wrapping `loadRemoteModule` in `lazy()` so failures carry a logical id |
| `apps/prod-host/src/app/domain.ts`      | Declaring your current shape as the base version                       |
| `tools/deploy-demo.mjs`                 | The three-step stamp → build → manifest pipeline                       |

The adoption rule holds here too: take one package, take three, take none of the Angular ones. Nothing is load-bearing for anything else.

### If something doesn't work

**The ports are in use.** The demo runs on 4410/4411 to stay clear of the usual 4200. Changing them means changing four places together: `serve-dist` (and `serve-original`, for `demo:prod:dev`) in each app's `project.json`, and `apps/prod-host/public/federation.manifest.json`, which is the URL the host actually resolves at runtime.

**Scenario 1 just works, with no pause.** You reloaded after redeploying. A fresh page load fetches the new `remoteEntry.json` and there's nothing stale left to fail. The sequence has to be: load → redeploy → click.

**Scenario 1 reports `exhausted`.** The recovery budget is spent for this build in this tab. See above.

**The editor never loads, in any scenario.** Check the remote is actually up: `curl http://localhost:4411/remoteEntry.json`. The host fetches it cross-origin, so the static server must send CORS headers — `serve-dist` sets `cors: true`.

**`demo:prod:serve` prints "Waiting for … in another nx process" and exits immediately.** Nx dedupes continuous targets across concurrent invocations, and a server killed abruptly can leave that lock behind — the new run then attaches to a process that is no longer there and reports success while serving nothing. Both ports will refuse connections.

```sh
npx nx reset
npm run demo:prod:serve
```

Redeploying from a second terminal while the servers run is fine — that's a different target, and the servers survive it. This only bites after a hard kill.

---

## Development

```sh
npm install
npm run verify                   # lint + test + build, every library

npm test                         # all projects
npm run test:libs                # libraries only
npm run test:core                # 44 · also :build-tools :angular-router :angular-data :angular-workflow

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
