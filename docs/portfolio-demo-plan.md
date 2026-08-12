# Implementation plan — NestJS portfolio API + federated portfolio demo

**Audience:** an AI coding agent working through this one phase at a time.
**Repo:** `/Users/jeffreysmith/dev/ngx-drift` (Nx 23.1.1, Angular 22.0.x, TypeScript ~6.0.3).

Work **phase by phase**. Every phase ends with a **CHECKPOINT** — a command to run and the
output to expect. Do not start a phase until the previous checkpoint passes. If a checkpoint
fails, fix it before continuing; do not carry a broken step forward.

> **Amended after execution.** Several things below no longer match the running app, per later
> feedback. The SSE stream has **no timer at all** — it fires only when the UI asks it to
> (§7 originally specified a 5s–180s random interval), and every breach targets the one
> ticker all funds hold. The book was slimmed from eight funds to **five**, and the ticker
> universe to **twenty**. The
> Basics tab's `Editor` load (§9's Checkpoint 7 discussion of `/basics/editor`) is no longer
> routed — it's fetched with `loadRemoteModule()` + `lazy()` and mounted inline on the page
> with `NgComponentOutlet`, no route at all. The router-based redeploy/recovery scenario this
> plan describes for Basics now lives on the Portfolio tab's `/portfolio/fund/:id` route
> instead. See `README.md`'s scenario 1 for the current version. The plan's reasoning
> otherwise still holds; this note exists so the numbers and routes below aren't taken as
> current fact.

---

## 0 · Read this first — rules and traps

These are mistakes that have already been made in this repo. Violating them creates work that
has to be undone.

| Rule                                                                                                                                                               | Why                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Never run `prettier --write` on `libs/`.** Only format files you created or edited, and pass their explicit paths.                                               | Most of `libs/` is not Prettier-formatted. A blanket run reformats ~20 files you did not touch and buries your real change in noise.                                                                |
| **Never run `prettier --write .`**                                                                                                                                 | Same reason, workspace-wide.                                                                                                                                                                        |
| **Do not "fix" pre-existing lint errors.**                                                                                                                         | `core:lint` (`no-empty`) and `angular-router/data/workflow:lint` (missing peerDeps) already fail on `main`. They are not yours. Leave them.                                                         |
| **Do not add anything to a library's public API without being asked.**                                                                                             | The `@skewkit/*` packages are published. This plan adds **no** library code.                                                                                                                           |
| **Do not use `injectWorkflow()` in `prod-remote`.**                                                                                                                | `WorkflowRuntime.attach()` dedupes by workflow id; the host attaches first and you silently get the host's older definition. See the comment on `wizardV2` in `apps/prod-remote/src/app/domain.ts`. |
| **`apps/*/src/generated/build-id.ts` is generated.** Do not hand-edit; `tools/deploy-demo.mjs` overwrites it on every build.                                       |                                                                                                                                                                                                     |
| **Never use Bash to run dev servers.** Use the preview/browser tooling, or run the documented npm scripts in the background and poll with `curl`.                  |                                                                                                                                                                                                     |
| **If `npm run demo:prod:serve` prints "Waiting for … in another nx process" and exits**, run `npx nx reset` then retry.                                            | Nx dedupes continuous targets; a hard-killed server leaves a stale lock and the new run reports success while serving nothing.                                                                      |
| **Ports:** host `4410`, remote `4411`, same-origin server `4420`, **new: API `3333`**. Check they are free before starting; other sessions may hold `4200`/`4300`. |                                                                                                                                                                                                     |
| **`domain.ts` is duplicated between host and remote on purpose.** Do not extract it into a shared lib.                                                             | A shared library makes them one deployment and deletes the problem the demo exists to show.                                                                                                         |

**Scope boundary for this work:** you are adding one new app (`apps/api`) and new _feature_ code
inside `apps/prod-host` and `apps/prod-remote`. You are not modifying `libs/`.

---

## 1 · What already exists

```
apps/
  shell/          simulated demo (older, toggle-based) — do not touch
  prod-host/      federated HOST, "older" deployment. Draft schema v1, wizard 0.1.
  prod-remote/    federated REMOTE, "newer" deployment. Draft schema v2, wizard 0.2.
                  Exposes ./Editor via Native Federation.
libs/             @skewkit/core, /build, /angular-router, /angular-data, /angular-workflow
tools/
  deploy-demo.mjs        stamps identity → builds → emits manifest
  serve-same-origin.mjs  serves host at / and remote at /remote/ on one origin
```

Key existing host files you will modify:

- `src/app/app.routes.ts` — routes
- `src/app/app.ts` — shell chrome, protections switch, trace panel
- `src/app/app.config.ts` — providers
- `src/app/home/home.ts` — the current 4 demo cards
- `src/app/lab.ts` — `Lab` service: protections toggle + trace log
- `src/app/load-remote.ts` — `loadRemote()` helper wrapping `loadRemoteModule` in `lazy()`
- `src/app/cards.css` — shared card styles

Existing remote files:

- `src/app/editor/editor.ts` — the exposed `./Editor` component
- `src/app/domain.ts` — remote's schema declarations
- `src/app/trace.ts` — writes trace entries the host's panel displays
- `federation.config.mjs` — `exposes` map

---

## 2 · Design decisions (do not redesign these)

### 2.1 The data contracts

The server serves **both versions simultaneously**. This is the point: two live API versions,
two clients pinned to different ones.

**v1 — what the HOST understands.**

```ts
export interface FundV1 {
  id: string;
  name: string;
  currency: string; // 'USD'
  nav: number; // scalar
  cashPct: number; // scalar
  holdings: HoldingV1[];
}

export interface HoldingV1 {
  ticker: string;
  name: string;
  weightPct: number;
  marketValue: number; // scalar
}
```

**v2 — what the REMOTE understands.** Three kinds of change, chosen deliberately so the
migration is not trivial: a **rename**, two **scalar → structured** promotions, and **added
fields** that v1 never carried.

```ts
export interface FundV2 {
  id: string;
  name: string;
  baseCurrency: string; // RENAMED from `currency`
  nav: { amount: number; asOf: string }; // PROMOTED from scalar
  liquidity: {
    cashPct: number; // absorbed from top-level `cashPct`
    hqlaPct: number; // NEW — v1 cannot supply this
    redemptionCoverDays: number; // NEW
  };
  classification: { assetClass: string; strategy: string }; // NEW
  holdings: HoldingV2[];
}

export interface HoldingV2 {
  ticker: string;
  name: string;
  weightPct: number;
  marketValue: { amount: number; currency: string }; // PROMOTED from scalar
  liquidityTier: 'T1' | 'T2' | 'T3'; // NEW
}
```

**The migration (v1 → v2)** lives only in the remote. Fields v1 cannot supply must be filled
with a value that is _visibly_ a default, because the reconciliation UX in Phase 9 depends on
being able to say "this was derived, not reported":

| v2 field                        | From v1                                                        |
| ------------------------------- | -------------------------------------------------------------- |
| `baseCurrency`                  | `currency`                                                     |
| `nav.amount`                    | `nav`                                                          |
| `nav.asOf`                      | migration time (`new Date().toISOString()`)                    |
| `liquidity.cashPct`             | `cashPct`                                                      |
| `liquidity.hqlaPct`             | `0` — **derived, unknown**                                     |
| `liquidity.redemptionCoverDays` | `0` — **derived, unknown**                                     |
| `classification`                | `{ assetClass: 'unknown', strategy: 'unknown' }` — **derived** |
| `holdings[].marketValue`        | `{ amount: marketValue, currency: currency }`                  |
| `holdings[].liquidityTier`      | `'T2'` — **derived, a guess**                                  |

### 2.2 The skew story this demonstrates

| Boundary                      | How the demo shows it                                                                                                                                                                                                                                                                                               |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Host ↔ fragment**          | Host holds v1 funds. It hands the selected fund to the remote, which understands v2. The remote migrates it forward, then fetches the authoritative v2 from the API and **reconciles** — showing which fields the migration guessed and which the server actually reported.                                         |
| **Client ↔ API**             | An order is queued in the `@skewkit/angular-data` outbox stamped with the contract version it was authored under. If it flushes against a _newer_ API the server returns `409` with the expected version; the client migrates the queued payload forward and retries. This is the row the current demo does not cover. |
| **Client ↔ origin**          | Already covered by the existing chunk-recovery scenario. Unchanged.                                                                                                                                                                                                                                                 |
| **Past self ↔ present self** | Already covered by the draft/wizard scenarios. Unchanged.                                                                                                                                                                                                                                                           |

### 2.3 Transport choices

- **SSE** — native `EventSource` in the browser. No library.
- **WebSocket** — `@nestjs/platform-ws` server side (the `ws` package), native `WebSocket` in
  the browser. **Do not use socket.io**; it would add a client dependency to both Angular apps.
- **HTTP** — Angular `HttpClient`. Neither app currently calls `provideHttpClient()`; you will add it.

### 2.4 Tabs

Requirement: keep current capabilities behind a **Basics** tab (the default), put the new
material behind a **Portfolio** tab.

```
/                      → redirect to /basics
/basics                → existing Home (the 4 cards)          ← DEFAULT
/basics/editor         → remote ./Editor       (was /editor)
/portfolio             → new PortfolioPage (fund list + ticker + SSE)
/portfolio/fund/:id    → remote ./FundDetail
```

---

## 3 · PHASE 1 — Scaffold the NestJS app

### Steps

1. Install the Nx Nest plugin:

   ```bash
   npm install -D @nx/nest@23.1.1
   ```

2. Inspect the generator's options before running it — do not guess flags:

   ```bash
   npx nx g @nx/nest:application --help
   ```

3. Generate the app. Adjust flag names to match the help output if they differ:

   ```bash
   npx nx g @nx/nest:application --name=api --directory=apps/api --no-interactive
   ```

4. Open `apps/api/project.json` and record the actual target names (`build`, `serve`) and the
   executor used. You will need them for the npm scripts in Phase 10.

5. **TypeScript config.** The workspace root `tsconfig.base.json` uses
   `"moduleResolution": "bundler"`, which is wrong for a Node server. In
   `apps/api/tsconfig.app.json` ensure the compilerOptions include:

   ```jsonc
   {
     "module": "commonjs",
     "moduleResolution": "node",
     "emitDecoratorMetadata": true,
     "experimentalDecorators": true,
     "target": "es2021",
     "types": ["node"],
   }
   ```

   `emitDecoratorMetadata` and `experimentalDecorators` are already `true` in the base config,
   but set them explicitly here so the app does not break if the base changes.

6. Set the port to **3333** and enable CORS in `apps/api/src/main.ts`:

   ```ts
   const app = await NestFactory.create(AppModule);
   app.enableCors({
     origin: ['http://localhost:4410', 'http://localhost:4411', 'http://localhost:4420'],
   });
   app.setGlobalPrefix('api');
   await app.listen(3333);
   ```

   All three origins are required: host, remote-standalone, and the one-origin server.

### CHECKPOINT 1

```bash
npx nx build api
```

Expect: `Successfully ran target build for project api`.

Then start it (background) and confirm it answers:

```bash
npx nx serve api
# in another shell:
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3333/api
```

Expect `200` or `404` (a 404 is fine — it means Nest is listening). A connection refused means
it is not.

**If TypeScript 6 rejects the NestJS decorators**, stop and report the exact error rather than
downgrading TypeScript or changing `tsconfig.base.json`. That is a workspace-wide decision.

---

## 4 · PHASE 2 — Mock data and the versioned funds endpoints

### Steps

1. Create `apps/api/src/app/portfolio/mock-data.ts`. Define **8 funds** as v1 shapes, each with
   **5–12 holdings**. Use realistic names — this is investment/portfolio data, not `foo`/`bar`.
   Suggested funds: a global equity fund, an EM debt fund, an IG credit fund, a short-duration
   liquidity fund, a multi-asset balanced fund, a REIT fund, a high-yield fund, a gilt fund.
   Ticker symbols should be plausible and reused across funds so a single ticker moving affects
   several funds (Phase 4 depends on this overlap).

   Keep the data **deterministic** — a fixed literal array, not randomly generated at boot.
   Random data makes every reload a different demo and makes bugs unreproducible.

2. Create `apps/api/src/app/portfolio/to-v2.ts` — a pure function `toFundV2(fund: FundV1): FundV2`
   implementing the mapping table in §2.1. This is the _server's_ upgrade path and is
   independent of the client-side migration in Phase 6. They must agree on the authoritative
   fields and may differ on the derived ones — that difference is what the reconciliation UX
   surfaces.

   Make the server supply **real** values for the fields v1 cannot express:
   `hqlaPct`, `redemptionCoverDays`, `classification`, and per-holding `liquidityTier` should be
   genuine per-fund data held alongside the mock (add a `v2Extras` map keyed by fund id), not
   zeros. The client migration fills zeros; the server reports truth; the UI shows the gap.

3. Controllers:
   - `apps/api/src/app/portfolio/funds-v1.controller.ts` → `@Controller('v1/funds')`
     - `GET /api/v1/funds` → `FundV1[]`
     - `GET /api/v1/funds/:id` → `FundV1` or 404
   - `apps/api/src/app/portfolio/funds-v2.controller.ts` → `@Controller('v2/funds')`
     - `GET /api/v2/funds` → `FundV2[]`
     - `GET /api/v2/funds/:id` → `FundV2` or 404

4. **Wrap every response in a `@skewkit/core` envelope.** The response body must be:

   ```jsonc
   { "v": 1, "payload": [ /* funds */ ] }   // from /api/v1/funds
   { "v": 2, "payload": [ /* funds */ ] }   // from /api/v2/funds
   ```

   Do **not** import `@skewkit/core` into the Nest app to do this — the server is a separate
   deployment and must not share code with the client. Write the two-line literal by hand. The
   envelope shape (`{ v, payload }`) is the contract; the library is one implementation of it.

5. Register both controllers in `apps/api/src/app/app.module.ts`.

### CHECKPOINT 2

```bash
curl -s http://localhost:3333/api/v1/funds | head -c 200
curl -s http://localhost:3333/api/v2/funds/<some-id> | head -c 300
```

Expect a `{"v":1,"payload":[...]}` envelope from the first and `{"v":2,...}` from the second,
with `baseCurrency`, `nav.amount`, `liquidity.hqlaPct` present in the v2 body and absent in v1.

---

## 5 · PHASE 3 — SSE liquidity-breach stream

### Contract

```ts
export interface LiquidityBreachV1 {
  id: string;
  at: string; // ISO
  severity: 'warning' | 'breach';
  trigger: {
    kind: 'order' | 'adjustment' | 'transaction';
    ref: string; // e.g. 'ORD-10422'
    description: string; // human sentence
    amount: number;
  };
  impacted: Array<{
    fundId: string;
    fundName: string;
    cashPctBefore: number;
    cashPctAfter: number; // below thresholdPct when severity==='breach'
    thresholdPct: number;
  }>;
  suggestedAction: {
    kind: 'raise-cash' | 'sell-holding' | 'defer-redemption';
    ticker?: string;
    amount: number;
    rationale: string;
  };
}
```

### Steps

1. `apps/api/src/app/portfolio/breach.service.ts` — generates a random breach:
   - pick a random trigger kind
   - pick 1–3 random funds from the mock data as `impacted`
   - `cashPctAfter` must be below `thresholdPct` when `severity === 'breach'`
   - `suggestedAction.amount` should plausibly close the gap
   - `rationale` a short sentence referencing the fund and the shortfall

2. `apps/api/src/app/portfolio/events.controller.ts`:

   ```ts
   @Controller('events')
   export class EventsController {
     @Sse('liquidity')
     liquidity(): Observable<MessageEvent> {
       /* … */
     }
   }
   ```

   **Timing:** the next event fires after a random delay in **[5s, 180s]**. Implement with a
   recursive `timer(randomDelay)` / `expand`, or `interval(1000)` gated by a next-fire timestamp
   — do not use a fixed interval.

   **Emit one event immediately on connect** so a developer opening the page is not staring at
   nothing for up to three minutes. Say so in a code comment; it is a demo affordance, not the
   steady-state behaviour.

   **Envelope the payload** the same way as Phase 2: `data` is `{ v: 1, payload: <breach> }`.

3. Add a **debug trigger**: `POST /api/events/liquidity/trigger` that emits a breach immediately
   to all connected clients. Without it, testing Phase 8 means waiting out a random delay.
   Comment it as demo-only.

### CHECKPOINT 3

```bash
curl -N -s http://localhost:3333/api/events/liquidity | head -c 400
```

Expect an immediate `data: {"v":1,"payload":{...}}` line. Leave it running, then in another
shell:

```bash
curl -s -X POST http://localhost:3333/api/events/liquidity/trigger
```

Expect a second `data:` line to appear in the first shell within a second.

---

## 6 · PHASE 4 — WebSocket ticker feed

### Contract

```ts
export interface TickV1 {
  ticker: string;
  name: string;
  price: number;
  changePct: number; // this tick
  direction: 'up' | 'down' | 'flat';
  at: string;
  impactedFunds: Array<{
    fundId: string;
    fundName: string;
    weightPct: number; // this holding's weight in that fund
    navImpactPct: number; // weightPct * changePct / 100
  }>;
}
```

### Steps

1. Install: `npm install @nestjs/websockets @nestjs/platform-ws ws` and `npm install -D @types/ws`.

2. In `main.ts`: `app.useWebSocketAdapter(new WsAdapter(app));` (from `@nestjs/platform-ws`).

3. `apps/api/src/app/portfolio/ticker.gateway.ts` — a `@WebSocketGateway({ path: '/ws/ticker' })`.
   On a client connecting, start emitting a tick roughly **every 1000 ms**.
   - Walk prices with a small random drift from a seeded starting price per ticker; do not
     regenerate prices from scratch each tick or the chart will be nonsense.
   - `impactedFunds` must be **derived from the mock holdings** — every fund holding that ticker,
     with its real `weightPct`. This is the drill-down the requirement asks for.
   - Send frames as `JSON.stringify({ event: 'tick', data: { v: 1, payload: tick } })`.

4. Stop the interval on disconnect. A leaked interval per connection will degrade the demo over
   a long session.

### CHECKPOINT 4

Use a short Node script (not a browser) to verify:

```bash
node -e "
const WebSocket = require('ws');
const ws = new WebSocket('ws://localhost:3333/ws/ticker');
let n = 0;
ws.on('message', (m) => { console.log(String(m).slice(0, 160)); if (++n === 3) process.exit(0); });
ws.on('error', (e) => { console.error('ERR', e.message); process.exit(1); });
"
```

Expect 3 frames, each with a different `price`, and a non-empty `impactedFunds` array.

---

## 7 · PHASE 5 — Versioned orders endpoint

This backs the "POST a mock order that addresses the liquidity breach" requirement and the
client↔API skew story.

### Contracts

```ts
export interface OrderV1 {
  fundId: string;
  action: 'raise-cash' | 'sell-holding' | 'defer-redemption';
  ticker?: string;
  amount: number; // scalar
  note?: string;
}

export interface OrderV2 {
  fundId: string;
  action: 'raise-cash' | 'sell-holding' | 'defer-redemption';
  ticker?: string;
  amount: { value: number; currency: string }; // PROMOTED
  note?: string;
  breachRef: string; // NEW — REQUIRED, links order to the breach
  idempotencyKey: string; // NEW — REQUIRED
}
```

### Steps

1. `POST /api/v1/orders` — accepts an `OrderV1` envelope (`{ v: 1, payload }`). Returns
   `{ v: 1, payload: { orderId, accepted: true, ... } }`.

2. `POST /api/v2/orders` — accepts `{ v: 2, payload: OrderV2 }`.
   **If it receives an envelope with `v: 1`, respond `409 Conflict`** with:

   ```jsonc
   { "error": "version-skew", "expected": 2, "received": 1, "message": "Order was authored against contract v1; this endpoint requires v2." }
   ```

   This is the whole point: the queued mutation must discover the disagreement, not be silently
   coerced. Do not "helpfully" upgrade a v1 body on the server.

3. Keep accepted orders in an in-memory array and expose `GET /api/v1/orders` and
   `GET /api/v2/orders` so the UI can show what landed.

### CHECKPOINT 5

```bash
curl -s -X POST http://localhost:3333/api/v2/orders \
  -H 'content-type: application/json' \
  -d '{"v":1,"payload":{"fundId":"f-001","action":"raise-cash","amount":250000}}' \
  -w "\nHTTP %{http_code}\n"
```

Expect `HTTP 409` and an `error: "version-skew"` body.

---

## 8 · PHASE 6 — Client-side contracts in the Angular apps

**Duplicate these per app.** Do not create a shared lib. Follow the existing pattern in
`apps/prod-host/src/app/domain.ts` — including its comment explaining _why_ the duplication is
deliberate.

### Steps

1. `apps/prod-host/src/app/portfolio/contracts.ts`
   - `FundV1`, `HoldingV1` interfaces
   - `export const FundSchemaV1 = versioned<FundV1[]>('portfolio-funds');`
   - `OrderV1` + `export const OrderSchemaV1 = versioned<OrderV1>('portfolio-order');`
   - `LiquidityBreachV1` + `export const BreachSchemaV1 = versioned<LiquidityBreachV1>('liquidity-breach');`
   - `TickV1` + `export const TickSchemaV1 = versioned<TickV1>('ticker-tick');`

2. `apps/prod-remote/src/app/portfolio/contracts.ts`
   - A **frozen private copy** of `FundV1` (not exported, never edited again — same rule as
     `DraftV1` in the remote's existing `domain.ts`)
   - `FundV2`, `HoldingV2` exported
   - `export const FundSchemaV2 = versioned<FundV1[]>('portfolio-funds').next<FundV2[]>('…', migrate)`
     implementing §2.1's mapping table
   - `OrderV2` + `export const OrderSchemaV2 = versioned<OrderV1>('portfolio-order').next<OrderV2>('…', migrate)`
     — the v1→v2 order migration wraps `amount`, and must **generate** `idempotencyKey` and take
     `breachRef` from the entry it is migrating. If `breachRef` is genuinely unavailable, use
     `'unknown'` and surface that in the UI rather than inventing one.

3. Add `provideHttpClient()` to **both** `app.config.ts` files (import from
   `@angular/common/http`). Neither app has it today.

### CHECKPOINT 6

```bash
npx nx build prod-host && npx nx build prod-remote
```

Both must succeed. No runtime behaviour yet.

---

## 9 · PHASE 7 — Restructure the host into tabs

### Steps

1. Move the existing `Home` component to `apps/prod-host/src/app/basics/basics-page.ts`
   (rename the class to `BasicsPage`, keep every card and behaviour identical).

2. Rewrite `apps/prod-host/src/app/app.routes.ts` to the shape in §2.4. Notes:
   - `/` redirects to `/basics` — **`pathMatch: 'full'`** on the redirect or it will loop.
   - The existing remote route moves from `/editor` to `/basics/editor`. Keep the `loadRemote()`
     wrapper and the **module id `'remote-editor'` unchanged** — it is the key the skew manifest
     uses, and changing it silently breaks route-deletion detection.
   - Add `/portfolio/fund/:id` using `loadRemote('remote-fund-detail', 'prod-remote', './FundDetail', …)`.

3. Add a tab strip to `apps/prod-host/src/app/app.ts`, below the header and **above** the
   protections switch. Two tabs: **Basics** (default) and **Portfolio**. Use
   `routerLinkActive` for the active state. Style it in `app.css` consistently with the existing
   `nav` block.

4. Keep the protections switch and trace panel visible on **both** tabs — they apply to
   everything.

### CHECKPOINT 7

Build, deploy, serve, and confirm in a browser:

- `http://localhost:4410/` lands on **Basics** with all four original cards working
- the protections toggle still flips bytes on card 1 (`{"v":1,"payload":…}` → bare object)
- `http://localhost:4410/basics/editor` still loads the remote editor
- `http://localhost:4410/portfolio` renders (empty is fine at this stage)

**Do not proceed until the original demo is provably intact.** The requirement is explicit that
current capabilities are kept.

---

## 10 · PHASE 8 — Host portfolio tab

`apps/prod-host/src/app/portfolio/portfolio-page.ts`. Three regions:

### 10.1 Fund list (left)

- Fetches `GET http://localhost:3333/api/v1/funds` — **the host is pinned to v1.**
- Reads the response envelope through `FundSchemaV1.read(body)`. On `ok === false`, render the
  failure with its `reason`; do not throw.
- Renders id, name, NAV, `cashPct`, holding count.
- Clicking a fund navigates to `/portfolio/fund/:id`.
- Highlight any fund named in the most recent breach.

### 10.2 Live ticker (top right)

- Native `WebSocket` to `ws://localhost:3333/ws/ticker`.
- Reads each frame through `TickSchemaV1.read(frame.data)`.
- Shows last ~12 ticks: ticker, price, `changePct`, direction arrow, colour.
- **Reconnect with backoff** if the socket closes; a dropped socket must not require a reload.
- Close the socket in `ngOnDestroy` / `DestroyRef` — a leaked socket per navigation is a real bug.

### 10.3 Breach feed (bottom right)

- Native `EventSource` on `http://localhost:3333/api/events/liquidity`.
- Reads through `BreachSchemaV1.read(JSON.parse(e.data))`.
- Renders severity, trigger, impacted funds, suggested action.
- Writes a `Lab` trace entry per breach (`inject(Lab)`, `lab.write('warn', 'breach', …)`).
- Close the `EventSource` on destroy.

### 10.4 Selected-fund handoff

When navigating to a fund, the host must make the **v1 fund it already holds** available to the
remote. Use the same medium the two builds already share — do not invent a new one and do not
try to import across the boundary:

- Write it to `sessionStorage` via `createVersionedStore(FundSchemaV1, …)` under a fixed key
  (e.g. `portfolio:selected-fund`), then navigate.
- The remote reads that key with **its own v2 schema** and migrates.

This is the host↔fragment boundary made concrete, and it reuses the pattern already established
by `apps/prod-remote/src/app/trace.ts`.

### CHECKPOINT 8

With the API running, `http://localhost:4410/portfolio` shows a fund list, ticks arriving about
once a second, and at least one breach (use the debug trigger). Toggling protections **off** and
reloading should make the envelope reads stop being checked — note in the trace what changes.

---

## 11 · PHASE 9 — Remote fund-detail (the reconciliation UX)

Create `apps/prod-remote/src/app/portfolio/fund-detail.ts`, exporting `FundDetail`.
Add to `apps/prod-remote/federation.config.mjs`:

```js
exposes: {
  './Editor': './apps/prod-remote/src/app/editor/editor.ts',
  './FundDetail': './apps/prod-remote/src/app/portfolio/fund-detail.ts',
},
```

**Constraint:** like `Editor`, this component must take **no DI dependency the host must have
configured**, beyond `HttpClient` and the router. Read persisted envelopes; do not expect
host-provided services.

### 11.1 Three-way reconciliation — the centrepiece

On load the component holds up to three views of the same fund. Show them side by side and
label each:

1. **Handed over** — the v1 record from the host, migrated forward by `FundSchemaV2`.
   Mark every field the migration _derived_ (`hqlaPct`, `redemptionCoverDays`, `classification`,
   `liquidityTier`) with a "derived" badge. These are guesses.
2. **Authoritative** — `GET /api/v2/funds/:id`, read through `FundSchemaV2`.
3. **Difference** — a per-field diff of 1 vs 2. Fields where the migration guessed and the
   server disagrees are the interesting rows; render them prominently.

State clearly in the UI that the migration is _not wrong_ — it is the best answer available from
v1 data — and that the reconciliation is how you find out where the gaps are.

Handle `read()` failing with `reason === 'ahead'`: if the host ever hands over data from a
_newer_ contract than this build knows, refuse and explain, rather than rendering a partial fund.

### 11.2 Responding to a live update

The remote must react when a tick or breach affects **the fund currently on screen**:

- Subscribe to the same WebSocket (its own connection — it is a separate deployment).
- When a tick's `impactedFunds` includes this fund, show an inline banner:
  _"AAPL moved −1.8%; this fund's NAV impact ≈ −0.21%. [Refresh]"_
- Do **not** silently mutate what the user is looking at. Offer the refresh; let them take it.
  Silently re-rendering under someone mid-decision is the failure mode, not the fix.
- When a breach names this fund, surface the suggested action and enable the order form (11.3).

### 11.3 The order POST

A small form pre-filled from the breach's `suggestedAction`:

- Build an `OrderV2` (including `breachRef` and a generated `idempotencyKey`).
- Submit through the **`@skewkit/angular-data` outbox** (`OutboxService`) so it survives a reload:
  `register()` a runner at construction, then `enqueue()` on submit, then `flush()`.
- The runner POSTs to `/api/v2/orders` with a `{ v: 2, payload }` envelope.
- **Handle the 409.** On `error === 'version-skew'`, show what happened, migrate the queued
  payload with `OrderSchemaV2`, and retry. Log every step to the trace via `trace()` from
  `apps/prod-remote/src/app/trace.ts`.
- Provide a deliberate **"queue as v1"** button that enqueues an `OrderV1` against the v2
  endpoint, so the 409-then-migrate path can be demonstrated on demand rather than only by
  accident.

### CHECKPOINT 9

- `/portfolio/fund/:id` renders inside the host with all three reconciliation columns.
- The remote's build id in its banner differs from the host's.
- Opening the remote standalone (`http://localhost:4411/`) still works.
- The "queue as v1" button produces a 409 in the network tab, then a successful retry.

---

## 12 · PHASE 10 — Wiring, scripts, docs

1. **Same-origin server.** `tools/serve-same-origin.mjs` currently serves only the two Angular
   builds. Add a proxy so one origin covers everything:
   - `/api/*` → `http://localhost:3333/api/*`
   - `/ws/ticker` → WebSocket upgrade proxied to `localhost:3333`
     Use `node:http`'s `request` for HTTP and handle the `upgrade` event for the socket. Keep the
     existing path-traversal guard intact.
     In this mode the Angular apps should call **relative** URLs (`/api/v1/funds`), so put the API
     base URL behind a single exported helper per app rather than hard-coding `localhost:3333`.

2. **npm scripts** in root `package.json` (match the existing naming):

   ```jsonc
   "api": "nx serve api",
   "api:build": "nx build api",
   "demo:prod:full": "npm run demo:prod:build && nx run-many -t serve-dist,serve -p prod-host,prod-remote,api --parallel=3"
   ```

   Verify the target names against `apps/api/project.json` from Phase 1 before committing to this.

3. **README.** Add a _Portfolio demo_ subsection under `## Demos`, matching the existing house
   style: what it tests, how to run it, the scenarios, and what breaks without the protections.
   Update the tab structure note. **Do not** document `provideSkewDisabled` any further than it
   already is.

4. **Test counts.** If you add library tests (you should not need to), update the README badge
   and the packages table. Currently 189.

### CHECKPOINT 10 — full regression

```bash
npm run verify          # lint:libs will still fail on PRE-EXISTING errors — compare, do not fix
npm run test:libs       # expect 189 passed
npm run build:libs      # expect 5 projects
npx nx run-many -t lint -p prod-host prod-remote api
npm run demo:prod:build
```

Then in a browser, confirm **all** of:

|                 | Expect                                                                  |
| --------------- | ----------------------------------------------------------------------- |
| `/`             | redirects to Basics                                                     |
| Basics tab      | all 4 original cards behave as before, both protection modes            |
| Basics → editor | remote editor loads                                                     |
| Portfolio tab   | fund list (v1), live ticks, breach feed                                 |
| Fund detail     | three reconciliation columns, derived fields badged                     |
| Live update     | banner offering refresh, not a silent re-render                         |
| Order           | outbox flush succeeds; "queue as v1" 409s then migrates and retries     |
| Chunk recovery  | redeploy the remote mid-session; recovery still lands at the target URL |
| Same origin     | `npm run demo:prod:same-origin` — everything above still works on :4420 |

---

## 13 · Stop and ask

Do not guess on these. Report and wait:

1. **TypeScript 6 vs NestJS decorators.** If Phase 1 fails to compile, do not downgrade
   TypeScript or edit `tsconfig.base.json` — that affects every project in the workspace.
2. **`@nx/nest` generator flags differing from this plan.** Report the actual `--help` output.
3. **Any change that would require editing `libs/`.** This plan should need none. If you believe
   it does, say what and why first.
4. **Port conflicts** with servers you did not start.
5. If the reconciliation UI needs a design decision not covered in §11.1 — ask rather than
   inventing a fourth column.

---

## 14 · Suggested commit boundaries

One commit per phase, each independently reviewable:

1. `feat(api): scaffold nest app`
2. `feat(api): versioned funds endpoints with mock portfolio data`
3. `feat(api): SSE liquidity-breach stream`
4. `feat(api): websocket ticker feed`
5. `feat(api): versioned orders endpoint with 409 on contract skew`
6. `feat(demo): portfolio contracts and http client wiring`
7. `refactor(host): move existing demo behind a Basics tab`
8. `feat(host): portfolio tab — fund list, ticker, breach feed`
9. `feat(remote): fund detail with three-way reconciliation and order outbox`
10. `chore: same-origin proxy, scripts, README`
