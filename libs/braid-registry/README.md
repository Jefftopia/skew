# @skewkit/braid-registry

Immutable, content-addressed snapshots of a [Braid](../braid-gateway) fragment registry — plus the
analysis that tells you what a change would do.

```ts
import { createSnapshot, snapshotRegistry } from '@skewkit/braid-registry';
import { fileSnapshotStore } from '@skewkit/braid-registry/node';

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
import { validateRegistry, diffRegistries } from '@skewkit/braid-registry';

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

## Stores

| Store | Where | Use |
| --- | --- | --- |
| `memorySnapshotStore()` | `@skewkit/braid-registry` | tests, development |
| `fileSnapshotStore({ directory })` | `@skewkit/braid-registry/node` | single-instance primary, config volume, or the durable local cache |

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

See [`@skewkit/braid-cli`](../braid-cli), and
[the plan](../../docs/plans/braid-registry-console-plan.md) for where this is going.
