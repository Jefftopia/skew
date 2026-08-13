# Adopting Braid from Module Federation

You do not have to choose. A page can host federated remotes and Braid fragments at the same
time, so migration is per-remote and reversible — which matters, because for some remotes
federation is the better answer and should stay.

## What actually changes

Module Federation composes at **build/module** level: the host imports a remote's module and runs
it in the host's JavaScript context, sharing a dependency graph.

Braid composes at **runtime/DOM** level: the remote runs in its own realm with its own
dependency graph, and only its DOM enters the host page.

| | Module Federation | Braid |
| --- | --- | --- |
| Remote's dependencies | shared with the host, negotiated at runtime | isolated; two React majors cannot collide |
| Version skew | singletons must agree, or you get subtle breakage | structurally impossible for dependencies |
| Remote must be built for it | yes — `exposes`, shared config, matching bundler | no — compat takes an unmodified app |
| Server-side rendering | hard; needs coordinated SSR | the gateway composes SSR output |
| Cost | one JS context, smallest payload | one iframe realm per fragment |
| Failure mode | a shared-dep mismatch breaks the host | a broken fragment leaves the page standing |

**Keep federation** where remotes are small, share the host's framework version, and you want the
smallest possible payload. **Move to Braid** where a remote has its own release train, its own
framework version, needs SSR, or is a legacy app you cannot rebuild.

## Migrating one remote

The remote needs **no code changes** — that is the point of the compat adapter. The work is on
the host, and it is small.

**1. Serve the remote as an ordinary app.** A federated remote is already deployed somewhere; you
need it to serve a normal document at a route. Usually its existing dev/prod build already does.

**2. Register it with the gateway.**

```jsonc
{ "id": "billing", "endpoint": "https://billing.internal", "pierce": ["/billing/*"] }
```

**3. Replace the federated mount point with a slot.**

```diff
- const Billing = React.lazy(() => import('billing/Module'));
- <Suspense fallback={<Spinner/>}><Billing /></Suspense>
+ <braid-fragment name="billing" />
```

```diff
- loadRemoteModule({ remoteName: 'billing', exposedModule: './Module' })
+ <braid-fragment name="billing" />
```

**4. Drop the remote from the federation config** — its `remotes` entry, and any `shared`
singletons that existed only for it. That step is what pays: shared-dependency negotiation is
where federation's version-skew failures come from.

**5. Delete the remote's `exposes`** once no host references it, along with the federation plugin
if it was the last remote.

Do these one remote at a time. Between steps 3 and 5 the app is in a perfectly good state with
both mechanisms live.

## Things that need a decision, not a rewrite

**Shared state.** Federation lets remotes import a shared store directly. Braid fragments cannot —
different realms. Use the context bus (`braidContext.set` / `env.context`), which structured-clones
across the boundary. If a remote genuinely needs live shared object identity with the host, it is
a federation case, not a Braid case.

**Shared component libraries.** Under federation these are shared singletons; under Braid each
fragment bundles its own copy. That costs bytes and buys independent upgrades. Measure before
assuming it is a problem — a design system is usually small next to a framework.

**Routing.** A federated remote often uses the host's router instance. A Braid fragment uses its
own, bound to the host URL: its `routerLink`s drive the host, and host navigation drives it. No
shared router instance, and no `provideRouter` coordination.

**Cross-remote imports.** If remotes import each other, untangle that first; it is a coupling
federation permits and Braid does not.

## Running both at once

Nothing special is required. The gateway only claims `/__braid/*` and the page URLs a fragment
declares in `pierce`; federated chunk requests pass through untouched. Both can appear on one
page, and `braid dev` fronts the same dev servers you already run.

The only real conflict is **`publicPath` collisions**: a federated remote serving assets from a
path that a fragment's `pierce` pattern also matches. Fragment traffic is exact and
id-addressed, so it will not misroute — but a broad pattern like `pierce: ["/*"]` will try to
compose pages you did not mean. Keep pierce patterns narrow.

## Proposed tooling

None of this exists yet; it is the shape worth building if a migration is real.

**`braid migrate mf --remote <name>`** — read the federation config, emit the manifest entry for
that remote, and print the exact host-side diff (the `loadRemoteModule`/`React.lazy` call sites
to replace). Report what it could not determine rather than guessing.

**`braid doctor --mf`** — flag the specific hazards: a `shared` singleton that exists only for an
already-migrated remote, a `pierce` pattern overlapping a federated `publicPath`, remotes that
import each other.

**A codemod for mount points.** The call-site shapes are few and regular
(`React.lazy(() => import('remote/X'))`, Angular's `loadRemoteModule`, `loadRemoteEntry`), so
rewriting them to a slot is mechanical. Worth doing only after a couple of real migrations tell
us which shapes actually occur.

Start manually with one remote. A migration you have done once by hand is the only reliable
specification for the tool that does the rest.
