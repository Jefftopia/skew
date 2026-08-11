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

**Submitting an order** on a fund detail exercises the client↔API boundary:
the order goes through the `@skew/angular-data` outbox, and `/api/v2/orders`
refuses v1-shaped orders with `409 version-skew`; a "queue as v1" button lets
you watch the outbox runner catch the 409, migrate the payload, and retry.

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
