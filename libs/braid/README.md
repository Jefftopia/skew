# @skewkit/braid

The Braid client runtime — compose independently deployed frontend apps into one cohesive page:
one origin, one DOM, one accessibility tree, while each app keeps its own JavaScript world, its
own dependencies, and its own release train.

Braid is the composition layer of SkewKit. Its founding architecture lives in
[`docs/braid-architecture.md`](../../docs/braid-architecture.md).

Also see: [failure modes](../../docs/braid-failure-modes.md) ·
[working POC](../../docs/braid-poc.md) ·
[using Braid without the gateway](../../docs/braid-without-gateway.md)

## This build: compat adapter only, and by default

This build ships **C5, the compat adapter** — the contained, web-fragments-style emulation layer
for apps that cannot be told anything (the legacy monolith mid-migration) — and makes it the
**default adapter**: a fragment manifest that doesn't declare an adapter gets compat. Being a
fragment requires zero app-code changes; config only.

The contract runtime surface (`FragmentEnv`, the `BraidAdapter` interface) is defined and
exported, and **contract-blob realms work** (see below), but no contract adapters
(react/angular/vue/vanilla) ship yet, so nothing routes to them automatically.

## Realms

| Kind            | URL              | History involvement                        | Used by         |
| --------------- | ---------------- | ------------------------------------------ | --------------- |
| `compat-http`   | `/__braid/frag/…`| initial load only (`replaceState` after)   | compat adapter  |
| `contract-blob` | `blob:`          | none, ever                                 | contract adapters (none yet) |
| `sandbox`       | third-party      | —                                          | not in this build |

Contract-blob realms boot from a `blob:` URL the runtime authors: no network round trip, no
gateway stub, and zero interaction with the joint session history. Each carries a `<base>` into
the fragment's namespace and its own import map, which is how two fragments ship different
majors of the same dependency without a shared resolution namespace.

Verified empirically in Chromium (assumption A2): same-origin and DOM-capable, five realms add
**zero** history entries, per-realm import maps resolve, module evaluation works, and globals do
not leak between realms. Firefox and WebKit remain unverified here.

**Known platform limitation.** `window.location` and `document.location` are
`[LegacyUnforgeable]` — own, non-configurable properties that cannot be intercepted in any
realm, including one we authored. So the dev-mode guidance toward `env.*` (ledger entry M5)
covers `document` members but *cannot* cover `location`: a contract fragment reading `location`
silently gets the blob URL. This is the same platform rule that stops a blob document from
faking an http URL (assumption A3), and it is why compat mode keeps http realms.

## Piercing

When the gateway server-renders a fragment into the page, `<fragment-slot>` **adopts** that
content instead of fetching: the slot detects the declarative shadow root the gateway wrote,
and the compat adapter activates the already-neutralized content in place. `reload()` always
goes back to the network.

## Usage

Host page:

```ts
import { initBraid } from '@skewkit/braid';

initBraid({
  // wire your router so bound fragments observe host navigations (Braid never patches
  // the host History API — host purity is an invariant, not a mode):
  onHostNavigation: (notify) => router.afterEach(() => notify()),
});
```

```html
<fragment-slot name="legacy-billing"></fragment-slot>
```

Server: mount [`@skewkit/braid-gateway`](../braid-gateway) in front of your app and register a
manifest for `legacy-billing`. No fragment code is required.

## What the compat adapter does

- Boots each fragment's JS in a hidden same-origin iframe realm loaded from the gateway
  namespace (`/__braid/frag/:id/…`), restoring the fragment's route-url illusion via
  `history.replaceState`.
- Installs the document facade: a Proxy spliced into the realm document's prototype chain,
  driven by a generated WebIDL audit manifest — unaudited API use surfaces as loud diagnostics
  in dev mode.
- Confines all main-realm interception to the fragment boundary: per-node prototype stamping,
  born-inert scripts, and a shadow-root-scoped observer safety net.
- **Never patches a host-page global or prototype. In any mode. Ever.** (Ledger invariant M0.)

## Monkey-patch ledger

| #   | Where                   | What                                                                     |
| --- | ----------------------- | ------------------------------------------------------------------------ |
| M1  | compat realm (window)   | constructor `hasInstance`, observer/CSSOM constructor swaps, size getters, history proxy |
| M2  | compat realm (document) | proxy facade over the document prototype chain (WebIDL-audited)          |
| M3  | fragment DOM nodes      | per-node prototype stamping (insertion/clone/ownerDocument/getRootNode)  |
| M4  | fragment scripts        | born-inert `type` shadowing traps until activation                       |

All four are confined to the fragment's own realm and boundary; provenance is the
matrix-tested `Jefftopia/web-fragments` fork (4 configurations x 3 engines, 1,150 executions).
