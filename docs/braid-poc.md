# Braid POC — two Angular apps, one page

A working demonstration of the compat adapter: a **host** Angular app with SSR composes a
separately built, separately deployed **remote** Angular app into its own page, through the
Braid gateway. Neither app imports the other.

```bash
node tools/braid-poc/run.mjs
```

Then open <http://localhost:4500/billing/invoices>.

| Piece  | Where                    | What it is                                                       |
| ------ | ------------------------ | ---------------------------------------------------------------- |
| Host   | `apps/braid-poc-host`    | Angular SSR app; its Express server mounts the gateway in front  |
| Remote | `apps/braid-poc-remote`  | Stock Angular SPA with its own router; **zero** Braid code       |
| Gateway| in the host's `server.ts`| routes `/__braid/frag/billing/*`, pierces `/billing/*` documents |

## What the POC actually proves

**The remote is a normal Angular app.** Look at `apps/braid-poc-remote` — no Braid import, no
adapter, no build plugin, no awareness of being embedded. It uses `provideRouter`, `routerLink`,
and `signal()` exactly as it would standalone. Its manifest entry declares no `adapter`, so it
gets compat, which is the default.

**The composition is server-rendered.** A document request to `/billing/invoices` returns one
response containing the host's SSR output *with the remote's markup already inside the slot* as a
declarative shadow root. `curl` it and read the HTML — the remote's `<billing-root>` is there,
its scripts are `type="inert"`, and its `styles.css` has been re-rooted to
`/__braid/frag/billing/styles-*.css`. The client adopts that markup instead of fetching it.

**Routing works in every direction**, with one realm throughout:

| Navigation                              | Result                                            |
| --------------------------------------- | ------------------------------------------------- |
| Host router → `/billing/settings`       | fragment switches to its Settings route           |
| Fragment `routerLink` → `/billing/…`    | host URL changes, host nav highlights update      |
| Browser back / forward                  | both stay in sync, natively via `popstate`        |

**The host page stays pristine.** `Node.prototype` and the History API are untouched; the
remote's globals stay in its realm.

**Incremental hydration coexists with fragments.** The billing page also carries a
`@defer (hydrate on interaction)` block. It is server-rendered but dehydrated; its JavaScript
chunk downloads only when you click it, then it hydrates and the triggering click is replayed —
on the same page where a fragment boots into its own realm. Neither mechanism disturbs the other.

**The gateway publishes its registry.** `GET /__braid/registry` lists the composable apps. The
POC runs in development mode, so it returns everything including internal endpoints; see the
[gateway README](../libs/braid-gateway/README.md) for how roles, permissions, and pagination work
in production.

## The host's entire integration

The host uses [`@skewkit/braid-angular`](../libs/braid-angular/README.md), so the integration is
one provider and one element:

```ts
// main.ts
providers: [...appConfig.providers, provideBraid({ dev: true })];
```

```html
<!-- billing-page.ts -->
<braid-fragment name="billing" (ready)="onReady($event)" />
```

Plus the gateway registration in `server.ts`. That is the complete cost of hosting a fragment.

`provideBraid()` handles the router wiring that bound fragments need — subscribing to
`NavigationEnd`/`NavigationSkipped` rather than every router event, which is the difference
between a fragment that follows the host and one that lags a navigation behind. The component
keeps the page's templates strictly checked (no `CUSTOM_ELEMENTS_SCHEMA`) and turns
`braid:ready`/`braid:error` into typed outputs.

## Two things worth knowing

**Use an after-navigation hook, not every router event.** `NavigationStart` fires *before* the
URL changes; notifying then reports a location the page hasn't reached. The bus now tolerates
this (it keys duplicate-suppression on the URL, not on time alone), but filtering to
`NavigationEnd` is the correct wiring.

**Hydration is load-bearing.** Without `provideClientHydration()` on both bootstraps, Angular
discards the server-rendered DOM and re-creates it — destroying the slot the gateway just filled
and booting a *second* realm to fetch the fragment again. With hydration there is exactly one
realm, and the pierced content is what you see.

State note: navigating away from a fragment route and back re-creates the remote's routed
component, so component-level state resets — the same thing that happens in the remote
standalone. The realm and the application inside it are never rebooted.
