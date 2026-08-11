# The demo applications

This workspace ships two demos and a mock API. They answer different
questions:

|          | `apps/shell` (simulated)            | `apps/prod-host` + `apps/prod-remote` (production)   |
| -------- | ----------------------------------- | ---------------------------------------------------- |
| Question | what does each failure look like?   | does this survive a real deploy?                     |
| Failures | simulated by toggles                | provoked by actually redeploying                     |
| Bundles  | one dev build                       | two production builds, separate identities & origins |
| Run      | `npm run demo`                      | `npm run demo:prod`                                  |

## The simulated demo — `apps/shell`

```sh
npm run demo            # dev server on :4200
```

One application pretending to be two: "App 2" is a lazy route in the same
bundle, and a `Simulator` service fakes the deploy (purge the next chunk,
point the probe at a stale manifest, write a record as another build).
Everything the library *decides* is real; only the provocation is faked.

## The production demo — `apps/prod-host` + `apps/prod-remote`

Two Angular applications, built separately, stamped with separate build
identities, joined at runtime via
[Native Federation](https://www.npmjs.com/package/@angular-architects/native-federation).
Nothing is simulated: redeploying the remote deletes the content-hashed files
a running tab is holding, and the resulting 404 is the same one users get.

```sh
# terminal 1 — build and serve both
npm run demo:prod:build && npm run demo:prod:serve
# host  → http://localhost:4410   ← start here
# remote → http://localhost:4411  (same editor, standalone)

# terminal 2 — the interesting one: new build id, new hashes, old files gone
npm run demo:prod:redeploy-remote

# terminal 3 — the mock API (needed for the Portfolio tab / scenarios 1-2)
npm run api             # NestJS on :3333
```

`npm run demo:prod:same-origin` serves the same two builds behind one origin
(`:4420`, remote at `/remote/`) — closer to production, and required if you
want the standalone remote to see the host's `localStorage` (storage is
partitioned per origin, and the port is part of the origin).

### The scenarios (host UI walks you through each)

1. **A deploy lands under a live user** — Portfolio tab: open a fund,
   redeploy the remote, open another fund without reloading. `lazy()`
   retries, classifies, and reloads at the *target* URL (a plain
   `location.reload()` would lose the navigation intent).
2. **The origin is behind you** — open `:4410/?origin=rollback`, redeploy,
   navigate. Recovery is *withheld*: reloading against a stale origin would
   loop forever, so a banner hands the decision to the user.
3. **Reading data an older build wrote** — write v1 on the host, read as v2
   in the remote: migrated forward, derived fields labeled.
4. **Reading data a newer build wrote** — write v2 in the remote, read as v1
   on the host: a typed `ahead` refusal, data left intact. Step 5 of the
   walkthrough then *cures* it via the shared registry (`downgradedFrom: 2`,
   lost fields named); the Portfolio tab shows the same cure via the API's
   published contract (`readResolving`).
5. **A workflow that grew a step** — a wizard draft parked by 0.1 resumes
   under 0.2 with its payload migrated.
6. **The remote as a standalone app** — the same editor at its own URL.

A **protections switch** at the top of the host makes the `@skew` packages
inert (`setSkewDisabled()`, deliberately undocumented, only for this
comparison) so every scenario can be re-run to watch the unprotected code
fail on its own merits.

### The guided tour

First visit to the host opens a twelve-step tour: the page dims, a ring and a
caret point at one thing at a time, and the card explains why that thing is
there. It walks the header's build identity, the protections switch, the
Basics round trip, the remote drawer, the shared store key, the devtools
feed, and the Portfolio tab's contract cure — navigating between routes on
its own as it goes.

- **Start it whenever** — "Take the tour" (later "Replay the tour") sits
  beside the title and is always available; it is not a first-run-only modal.
- **Leave whenever** — Escape, the ×, or "Skip tour". Arrow keys move between
  steps, and the progress dots jump straight to one.
- **It remembers** — finishing or skipping writes
  `skew-demo:tour:v1` to `localStorage`, and it never auto-opens again.
  Clear that key (or run `localStorage.removeItem('skew-demo:tour:v1')`) to
  get the first-run behaviour back.

Targets are marked in the templates with the `hostTourAnchor` directive
(`apps/prod-host/src/app/tour/`), so a step either finds its element or shows
a "waiting" state — it never silently spotlights the wrong thing. Steps whose
element belongs to a lazy route wait for it to render.

### The guided tours

Each tab has its own walkthrough, reached from **"Tour this tab"** in the
header — it starts the tour for the tab you are on. The overlay dims the
page, rings the one thing being discussed, and explains why it is there.
Escape, the ×, or "Skip tour" leaves at any point; the progress dots jump
between steps. It auto-opens once on a first visit and never again, but it
is never unavailable — the preference lives in `localStorage` under
`skew-demo:tour:v1`.

- **Basics (10 steps)** — build identity, the protections switch, the
  Boundary Inspector, the five-step round trip, the remote pane, the shared
  storage key, and the devtools drawer.
- **Portfolio (11 steps)** — the v1-pinned fund list, the live ticker and
  breach feed, the `.well-known` contract cure, then the fund detail: the
  reconciliation against the authoritative record, the payload diff, the
  order outbox and its 409, and the offline queue.

Two details worth knowing if you extend them:

- Steps that need you to *do* something (step 6: "click any Detail →")
  spotlight the control and wait. While a step is waiting for a target that
  does not exist yet, the scrim stops blocking clicks — a tutorial that says
  "click Detail" and then swallows the click is worse than no tutorial.
- Four Portfolio steps target the **remote's** DOM (the fund detail is a
  separate deployment). The host cannot import the remote's components, and
  making the remote register anchors with the host's tour service would
  couple the two builds — the thing this demo argues against. So they agree
  on a tiny string contract instead: `data-tour="..."` in the remote's
  template, a CSS selector in the host's step. If the remote drops the
  attribute the step degrades to its waiting state rather than pointing at
  the wrong thing.

### The payload diff

Whenever a payload is cast in either direction, the Boundary Inspector shows
the record itself as a git-style diff underneath the field table — the v1
bytes on the left, the v2 result on the right, `+`/`−` gutters and all.

It is a *structural* diff rather than a text one: both sides are walked by
key path, so a promotion (`author` going from a string to
`{ name, email }`, or `cashPct` moving into `liquidity.cashPct`) reads as
one change instead of four unrelated line edits.

Lines also carry the migration's own vocabulary, which a plain red/green diff
would erase:

- **guessed** (amber) — the migration filled this in; the writer never
  recorded it. These are the `derivedPaths` from the read result.
- **cannot be carried** (red bar) — the older shape has nowhere to put this,
  so a downgrade drops it. These are the `lossyPaths`.

The engine is `diffPayloads` from **`@skew/studio`** — the first shipped
piece of the web debugger, where the same view is the drill-down from a
trace event. The apps only supply a renderer.

It appears in three places:

- **Basics · Boundary Inspector** — after every walkthrough step that casts
  a record, in both directions.
- **Portfolio · the contract card** — press "Fetch v2 & read as v1" and one
  fund is shown as the API sent it against the v1 projection the contract
  produced, with all six dropped paths marked.
- **Portfolio · fund detail** ("Compare the full records") — the most
  interesting one, because it is not a cast at all: it compares the record
  *migrated* from the host's v1 against the *authoritative* v2 the server
  returned. Every line the migration had to guess is marked, so you can see
  that a fund's HQLA was guessed at `0` when the real figure is `62.5`, and
  its asset class as `"unknown"` when it is `"Equity"`. The shortlist table
  above it is hand-picked; this is the whole record, and the guessed values
  are the ones nobody should act on without confirming.

### The devtools drawer

Below the activity feed sits **Skew devtools — live schema activity**: one
row per `read()`/`write()` on the page, from *both* builds, because the host
installs the `@skew/core` trace hook (`__SKEW_DEVTOOLS_HOOK__`, in
`main.ts`, before federation resolves) and the two builds share one core
instance. Run any scenario with it open: a v1→v2 migration shows as ↑ with
its derived paths, a registry- or contract-cured read as ↓ with its lossy
paths, and a refusal as the reason (`ahead`, `retired`, …) application code
received. Events carry versions and outcomes only — payloads are never
captured. The "only eventful" filter (default on) hides the once-a-second
ticker reads that would otherwise bury the interesting rows.

### The API boundary: contracts, orders, and offline

**The `.well-known` contract cure** lives on the Portfolio tab: the card
"Data from the future — cured by the contract" reads `/api/v2/funds` through
a v1 schema (refused, `ahead`), then again through `readResolving`, which
fetches `/.well-known/skew/contracts/portfolio-fund` from the API and
projects the response down to v1 with every dropped path named. Watch the
devtools drawer while pressing it — `ahead`, then `↓ downgraded from v2`.

**Submitting an order** on a fund detail exercises the client↔API boundary:
the order goes through the `@skew/angular-data` outbox, and `/api/v2/orders`
refuses v1-shaped orders with `409 version-skew`; a "queue as v1" button lets
you watch the outbox runner catch the 409, migrate the payload, and retry.

**Offline use**: the order form's "Simulate offline" toggle makes the POST
fail exactly as a dead network does. Submitted orders queue in the durable
outbox (`persistOutbox` — reload the page, they're still there, with a
"waiting to sync" badge), and flipping the toggle back flushes the queue
automatically. Nothing is lost in between; that is the outbox's promise.

### Resetting between runs

```js
// console on http://localhost:4410
localStorage.clear();   // drafts and the wizard run
sessionStorage.clear(); // recovery budget, activity record, protection mode
```

The recovery budget (`maxRecoveries`, default 1 per build) survives reloads
by design — a second run of scenario 1 in the same tab reports `exhausted`.
Redeploy the host (`npm run demo:prod:deploy-host`) or clear
`sessionStorage` to reset it.

### Troubleshooting

- **Scenario 1 "just works", no pause** — you reloaded after redeploying.
  Order matters: load → redeploy → click.
- **Editor never loads** — is the remote up?
  `curl http://localhost:4411/remoteEntry.json`.
- **`demo:prod:serve` exits immediately** ("Waiting for … in another nx
  process") — a stale Nx lock after a hard kill: `npx nx reset`, rerun.
- **Portfolio tab can't reach the API** — `npm run api` is a separate
  process; confirm with `curl http://localhost:3333/api/v1/funds`.
- **Changing ports** — two-origin mode hardcodes 4410/4411 in each app's
  `project.json` and `apps/prod-host/public/federation.manifest.json`;
  one-origin mode takes `node tools/serve-same-origin.mjs --port 5000`.

### Adapting the demo to your own app

| File                                    | What to copy                                                     |
| --------------------------------------- | ---------------------------------------------------------------- |
| `apps/prod-host/src/app/app.config.ts`  | `provideSkewRecovery` with a stamped identity and manifest URL   |
| `apps/prod-host/src/app/load-remote.ts` | Wrapping `loadRemoteModule` in `lazy()` for logical failure ids  |
| `apps/prod-host/src/app/domain.ts`      | Declaring your current shape as the base version                 |
| `tools/deploy-demo.mjs`                 | The stamp → build → manifest pipeline                            |

The full build-out spec for the portfolio demo (every phase and design
decision) is in [`docs/portfolio-demo-plan.md`](../docs/portfolio-demo-plan.md).
