# @braid/registry

Immutable, content-addressed snapshots of a [Braid](../braid-gateway) fragment registry — plus the
analysis that tells you what a change would do.

```ts
import { createSnapshot, snapshotRegistry } from '@braid/registry';
import { fileSnapshotStore } from '@braid/registry/node';

const store = fileSnapshotStore({ directory: '/var/lib/braid' });
await store.put(await createSnapshot({ manifests }));

createGateway({
  registry: snapshotRegistry({ store, pinned: process.env.BRAID_REGISTRY_SNAPSHOT }),
});
```

## Why snapshots

The registry sits on the request path — piercing resolves manifests while composing a document
response — so a registry backed by a live database makes gateway availability depend on that
database. Immutability fixes that, and pays for several other things on the way:

| Property | Because |
| --- | --- |
| Cacheable forever | a snapshot id names one byte-identical document; it can never mean something else later |
| Rollback is a pointer move | re-pin the previous id — no undo log, no inverse migration, nothing was mutated |
| Promotion is a pointer move | production pins the **byte-identical** artifact staging tested, not a re-render of the same intent |
| Survives a store outage | the pinned snapshot is already resolved; the store is needed to *change* config, not to serve it |
| Diffable | two ids and a diff — the reviewable artifact a config PR used to provide |

Ids are content addresses, so **publishing an unchanged registry is a no-op** rather than a new
artifact to reason about. `createdAt` and `labels` are excluded from the hash deliberately: they
describe the act of publishing, not the configuration being published.

## Resolution, and when it happens

`snapshotRegistry()` runs **once**. The gateway's `Registry` memoizes its source, so the store is
contacted during the first request that needs a manifest and never again.

Two consequences worth stating plainly:

1. The request path does not depend on the store past boot. That is the point.
2. **Re-pinning takes effect on restart.** A config change is a deploy, visible wherever deploys
   are visible. There is no hot re-pin.

## Falling back

```ts
snapshotRegistry({
  store,                                              // primary — S3, KV, Postgres
  pinned: process.env.BRAID_REGISTRY_SNAPSHOT,
  cache: fileSnapshotStore({ directory: '/var/cache/braid' }),
  fallback: 'last-known-good',                        // default
});
```

The cache must be **durable** to be useful. The failure it exists to cover is a cold boot against
an unreachable store, and an in-memory cache has nothing in it at that moment. Choose
`fallback: 'fail'` when serving stale routing is worse than serving nothing.

Snapshots are verified on read: content that does not hash to its id is refused, because that is
not staleness but alteration, and serving it would silently change which fragments compose which
pages.

## Analysis

Framework-free and dependency-free, so the same functions back `braid registry validate` in a
terminal and a console in a browser.

```ts
import { validateRegistry, diffRegistries } from '@braid/registry';

validateRegistry(manifests);          // conflicts decidable from the manifests alone
diffRegistries(published, proposed);  // what this config would change
```

`validateRegistry` catches duplicate and unaddressable ids, relative endpoints, invalid pierce
patterns, incomplete `custom-element` manifests, empty access rules, and — the one that is
invisible in a line-oriented diff — **two fragments whose pierce patterns claim the same page
URLs**. Overlap is a *warning*: a page composing several fragments is the feature, a stray `/*`
swallowing a sibling route is the bug, and only you can tell them apart.

Overlap detection is a documented heuristic. `URLPattern` exposes no intersection operation, so
each pattern is reduced to a sample path and cross-tested. That catches what happens in practice
and will miss patterns that intersect only on inputs the sample does not generate.

`diffRegistries` labels every change with the field's **owner**:

```
~ billing
    pierce (gateway)   ["/billing/*"] → ["/billing/*","/invoices/*"]
    title  (app)       "Billing" → "Billing & Invoices"
```

That split comes from one question — *can a lie here hurt anyone but the liar?* A changed `pierce`
is a routing change with page-wide blast radius; a changed `title` is a label. A flat list of
altered keys makes them look alike.

## Access preview

`satisfies()` is a pure function of a rule and a principal, so the effect of an access change is
*exactly* computable — no sampling, no observation. What is not available is a list of real users:
the gateway holds no principal directory. So the operator names who to test as, which is honest
about its inputs and still catches the change that matters.

```ts
const matrix = accessMatrix(proposed, [ANONYMOUS, { name: 'trader', roles: ['trader'] }], published);
matrix.losses; // ← the output that matters
```

**Losses are the finding; the grid is context for it.** A gain is usually deliberate and already
visible in the diff. A loss is how a fragment quietly stops being listed for the people who use it,
and nothing else in the toolchain would tell you.

Three details that are easy to get wrong:

- A removed fragment produces losses, not silence. Losing access by deletion is still losing
  access, and an operator should not have to cross-reference the diff to notice.
- `denied → absent` is **neither** a gain nor a loss. Classifying by "was not previously allowed"
  would announce that deleting a fragment granted people access to it.
- Manifests are not normalized first, because this runs while someone is still typing one. An
  incomplete manifest is `validateRegistry`'s finding to report, not this one's to throw on.

```bash
braid registry access --against ./snapshots --as 'trader:roles=trader'
```

Principals can also live in `braid.config.json` under `principals`, which makes them reviewable and
shared — the roles a deployment cares about are a property of the deployment, not of one command.
`anonymous` is always checked and never needs declaring.

## Traffic-informed impact

The static checks answer *"do these patterns overlap?"*. This answers *"and does anyone go there?"* —
which turns a warning an operator has to judge into a number they can act on. It is the only
analysis here that is **not** decidable from the manifests alone, which is why it needs a gateway to
have been recording and is opt-in at both ends.

```ts
const observations = createRoutingObservations({
  maxPaths: 5000,
  redact: (pathname) => pathname.replace(/\/invoices\/[^/]+/, '/invoices/:id'),
});

createGateway({ registry, observe: (event) => observations.record(event) });
```

```bash
braid registry impact --observations ./observations.json --against ./snapshots
```

```
  billing  −5 requests on 2 paths
  reviews  +3 requests on 1 path

requests  path
       4  /billing/settings  −billing
       3  /reports/q3        +reviews
       1  /billing           −billing

  8 of 20 observed requests affected
```

**An aggregate, not a log.** A log of every document request is unbounded, is a retention
liability, and answers no question this needs. What the analysis needs is the distinct paths, how
often each is served, and what composes there.

Three disciplines, all of which any request-path event sink needs:

| Concern | Approach |
| --- | --- |
| **Bounded memory** | `maxPaths` caps distinct paths; least-recently-seen is evicted first, keeping the sample weighted toward live traffic |
| **Redaction** | paths carry identifiers and sometimes personal ones — `redact` collapses them, which flattens cardinality at the same time |
| **Never blocking** | `observe` is synchronous, unawaited, and updates one map entry; a sink doing real work must buffer and flush elsewhere |

A capped set reports `sampled: true`, and every summary built from it says so. Truncated data that
reads as complete is worse than none.

Only **document** requests are observed — a soft navigation fetching the same URL is not a second
page view — and *every* document request is, not just pierce-matched ones. A path that composes
nothing today is exactly the path a widened pattern would start composing tomorrow, and reporting a
gain needs both sides.

## Stores

| Store | Where | Use |
| --- | --- | --- |
| `memorySnapshotStore()` | `@braid/registry` | tests, development |
| `fileSnapshotStore({ directory })` | `@braid/registry/node` | single-instance primary, config volume, or the durable local cache |

`SnapshotStore` is four methods and no update path, because a snapshot cannot be edited. Implement
it against whatever you already run.

The filesystem store writes atomically by rename, so a process dying mid-write leaves the previous
bytes intact rather than a truncated file that fails verification on the next boot. It refuses ids
that are not content addresses, so a crafted id cannot read outside its directory.

## The write API

Editing needs a server. `createRegistryApi` is fetch-native, like the gateway, and mounts wherever
you already handle requests:

```ts
const api = createRegistryApi({
  store,
  authorize: (request, action) => session(request).can(action), // 'read' | 'publish' | 'pin'
  fetchDescriptors: true,
});

const response = await api.handle(request); // null when the path is not ours
```

| Route | Does |
| --- | --- |
| `GET /head` | the pinned snapshot |
| `GET /snapshots` | recent snapshots, newest first |
| `GET /snapshots/:id` | one snapshot |
| `POST /snapshots` | validate → merge descriptors → mint → store → pin |
| `POST /head` | re-pin. **This is rollback**, and it is the whole of it |

**Writes are refused without an `authorize` hook.** There is no permissive default: an
unauthenticated publish endpoint is remote control of which fragments compose which pages. Reads
are allowed by default, matching the registry's own public-by-default posture.

Publishing **re-validates server-side** whatever arrives. A client may validate too — the console
does, as you type — but that is a convenience for whoever is typing, not the decision.

Drafts are deliberately not server state. Only published snapshots are, which keeps this to five
routes and sidesteps multi-editor reconciliation; the cost is that drafts do not follow you between
devices.

## Fragment descriptors

A fragment may publish facts about itself at `/.well-known/braid/fragment.json`, which the gateway
merges at publish time:

```jsonc
{ "braid": "1", "title": "Billing", "description": "Invoices and payment methods.",
  "tags": ["finance"] }
```

This exists because a manifest mixes fields owned by different teams, and a fact recorded by
someone other than the person who knows it drifts silently. The fix is not a permission matrix over
a shared document — it is letting the app publish its own facts next to the code that makes them
true.

**Always optional.** A fragment that publishes nothing keeps working exactly as it does today. That
floor must stay, because compat's whole promise is that being composed requires no change to the
app. Best generated as a build artifact, so nobody maintains it by hand.

Precedence, and why:

| Rule | Reason |
| --- | --- |
| Gateway-owned fields are **never** merged | a descriptor carrying `pierce`/`access`/`endpoint` is confused or hostile; the value is dropped **and reported** |
| An explicit manifest entry wins | a deliberate human override, and the escape hatch when a self-report is wrong |
| Otherwise the descriptor supplies it | the app knows its own title better than the platform team does |

Disagreements are surfaced, never resolved quietly — a disagreement usually means the app moved and
the manifest did not, which is the drift this exists to catch.

Fetching happens **at publish time, never on the request path**, so a gateway serving a snapshot
never reaches out to a fragment to learn what it is. A fragment that is unreachable does not fail
the publish; the previous values stand and the failure is reported.

## From the CLI

```bash
braid registry validate
braid registry publish --to ./snapshots --label by=ada --descriptors
braid registry diff --against ./snapshots
```

See [`@braid/cli`](../braid-cli), and
[the plan](../../docs/plans/braid-registry-console-plan.md) for where this is going.
