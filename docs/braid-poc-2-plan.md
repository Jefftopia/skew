# Plan — POC 2: an SSR'd remote embedded directly in the shell

**Status: proposed, not built.** This is the design for a second remote that differs from the
first one on two axes at once, and it needs one library change before it can work at all.

## What it is

A **notifications panel** that lives in the host's header — visible on every page, part of the
shell chrome rather than a routed screen. It is a separate Angular application with **its own
SSR**, deployed on its own schedule.

```
┌─ host shell (Angular SSR) ───────────────────────────────┐
│  [host nav]                    ┌── notifications ──────┐ │  ← remote #2, unbound,
│                                │  3 unread             │ │    on every page
│  ┌─ router-outlet ───────────┐ └───────────────────────┘ │
│  │  ┌─ billing fragment ───┐ │                           │  ← remote #1, bound to
│  │  │  (remote #1)         │ │                           │    the host router
│  │  └──────────────────────┘ │                           │
│  └───────────────────────────┘                           │
└──────────────────────────────────────────────────────────┘
```

## How it differs from POC 1, and why that matters

| | POC 1 (billing) | POC 2 (notifications) |
| --- | --- | --- |
| Placement | inside `router-outlet`, on `/billing/*` | in the shell template, on every page |
| Navigation | **bound** — drives and follows the host URL | **unbound** — has its own location, ignores the host's |
| Remote rendering | client-side SPA; piercing injects its app shell | **server-rendered**; piercing injects real content |
| Proves | routing across the boundary | SSR-into-SSR composition, and multi-fragment pages |

The combination is the point. POC 1 showed a fragment participating in host navigation. This one
shows a fragment that is *content*, composed into pages it knows nothing about, where both sides
render on the server — which is the arrangement most real shells actually want, and the one that
stresses piercing hardest.

---

## The library change this needs first

**Piercing currently fetches every fragment at the page's own path.** For a bound fragment that
is correct — the fragment renders the route the user is on. For an unbound widget it is wrong:
requesting `/billing/invoices` from the notifications endpoint is meaningless. Its content lives
at one fixed path.

Proposed change, in `@skewkit/braid-gateway`:

```jsonc
{
  "id": "notifications",
  "endpoint": "https://notifications.internal",
  "src": "/panel",        // the fragment's own path — what piercing fetches
  "bound": false,         // does not participate in host navigation
  "pierce": ["/", "/*"],  // appears on every page
  "timeoutMs": 400,
  "fallback": "placeholder"
}
```

- `pierceDocument` fetches `manifest.src` when present, instead of the page path.
- While rewriting the shell, the gateway sets `src` on the matching `<fragment-slot>`, so the
  host template stays `<fragment-slot name="notifications">` and the manifest remains the single
  source of truth for where the fragment lives.

**Decided: the host template sets `src` explicitly, and the manifest declares the same path.**

```html
<fragment-slot name="notifications" src="/panel"></fragment-slot>
```

An unbound fragment's mount path is therefore visible in the host's own template rather than
inferred, and it works identically whether or not the page was pierced — no metadata round trip,
no dependence on `pierce` patterns covering every route. The cost is that the path appears in two
places; the gateway will warn at registration when a manifest declares `bound: false` without a
`src`, and at pierce time when a slot's `src` disagrees with the manifest's, so the duplication
cannot drift silently.

(Considered and rejected: having the client fetch fragment metadata before booting — correct but
adds a round trip to every unbound fragment; and requiring `pierce` to cover every route the
widget appears on — free, but a config trap that fails by rendering nothing.)

---

## Work breakdown

**Phase 1 — gateway support for unbound fragments.** Add `src` and `bound` to the manifest,
teach `pierceDocument` to use `src`, inject `src` onto the slot during piercing, and unit-test
that a bound and an unbound fragment on the same page are each fetched at the right path.

**Phase 2 — the remote app** (`apps/braid-poc-notifications`). A standalone Angular app with
SSR: `provideServerRendering`, `provideClientHydration`, per-request rendering (not prerendered),
and a component whose markup is meaningfully server-rendered — a list of notifications rendered
from server state, so "the HTML arrived complete" is visible in `curl`. Still **zero** Braid code.
Served by its own Node server (its SSR output), added to the POC runner on port 4502.

**Phase 3 — host placement.** Add `<fragment-slot name="notifications">` to the host's shell
template, outside `router-outlet`, styled as header chrome. Register the manifest.

**Phase 4 — verification** (see checklist below).

**Phase 5 — docs.** Fold the result into [`braid-poc.md`](./braid-poc.md), and add anything new
to [`braid-failure-modes.md`](./braid-failure-modes.md).

---

## Risks, in the order I expect to hit them

**Angular hydration inside a fragment realm — the main unknown.** The remote's client bundle boots
in the realm and hydrates against DOM living in the host's shadow root, reached through the compat
document facade. Whether Angular's hydration traversal works through that facade is genuinely
untested. *Mitigation:* the failure is graceful — Angular reports a hydration mismatch and falls
back to destructive re-render, so the widget still works, just without the benefit. *Verify by:*
checking for NG0500-series console errors and confirming the SSR'd DOM nodes survive boot. If it
fails, that is a real finding worth its own investigation rather than a POC blocker.

**Transfer state.** Angular SSR emits `<script id="ng-state" type="application/json">`. The
gateway neutralizes every script, parking the real type in `data-script-type`, and the client
restores it before deciding not to execute data blocks — so it should arrive intact and readable
by `document.getElementById`. *Verify by:* asserting the element exists in the fragment's DOM with
its `application/json` type restored.

**Every page now pays for the widget.** With `pierce: ['/*']` the gateway fetches notifications on
every document request; a slow endpoint slows the whole site. *Mitigation:* a deliberately tight
`timeoutMs` and `fallback: 'placeholder'`, so a slow widget degrades to a client-side boot instead
of holding the page. Worth measuring, not just asserting.

**Two realms on one page.** Two fragments means two hidden iframes, each with a framework inside.
This is the cost the architecture accepts for isolation, and the POC is where it becomes concrete.
*Verify by:* measuring the page's memory with one fragment versus two.

**Unbound history.** An unbound fragment gets a standalone history stack — `pushState` becomes
`replaceState` internally so it cannot pollute the joint session history. *Verify by:* confirming
the host's `history.length` does not grow when the widget navigates internally.

---

## Verification checklist

Composition:
- [ ] `curl -H 'sec-fetch-dest: document'` on `/` shows the notifications markup **already
      rendered** inside its slot — not an empty app shell
- [ ] the same request on `/billing/invoices` pierces **both** fragments, each into its own slot
- [ ] each fragment is fetched at the right path: billing at the page path, notifications at `/panel`

Isolation and lifetime:
- [ ] exactly two realms on a two-fragment page
- [ ] navigating host routes does **not** reboot the widget (same realm, state preserved)
- [ ] the widget does not appear in or react to host navigation; host `history.length` is unaffected
- [ ] host `Node.prototype` and History API remain pristine

SSR quality:
- [ ] no NG0500-series hydration errors from the remote (or a recorded finding if there are)
- [ ] transfer-state script present and readable in the fragment's DOM
- [ ] the widget's stylesheet loads from `/__braid/frag/notifications/…`

Resilience:
- [ ] with the notifications endpoint stopped, every page still renders and the slot degrades to
      a placeholder
- [ ] with the endpoint made artificially slow, the page is not held past `timeoutMs`

---

## What I'd want confirmed before starting

1. That a header widget is the right shape. A footer, a sidebar, or a global search box would
   exercise the same mechanics; the header just makes "on every page" obvious.
2. Whether to demo host→fragment data flow (passing the signed-in user through the context bus).
   It is a natural fit for this fragment and would exercise C9, but it is scope beyond
   "SSR'd and not router-owned".

## Settled by POC 1

Incremental hydration is proven to coexist with fragments, so POC 2 can use it freely: a
`@defer (hydrate on interaction)` block on the same page as a fragment stays server-rendered and
dehydrated, downloads its chunk only on interaction, hydrates, and replays the triggering event —
while the fragment beside it boots into its own realm untouched. The remote in POC 2 should use
`@defer` internally too, so the same guarantee is tested from *inside* a fragment realm rather
than only beside one.
