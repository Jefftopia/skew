# @skewkit/braid — the client runtime

```ts
import { initBraid } from '@skewkit/braid';

initBraid({
  dev: true,
  onHostNavigation: (notify) => router.afterEach(() => notify()), // after-navigation only
});
```

```html
<fragment-slot name="billing"></fragment-slot>
```

Call `initBraid()` once, before any slot connects. It installs the compat adapter and defines the
element. In Angular use `provideBraid()` instead — it does this and wires the router correctly.

## `<fragment-slot>`

| Attribute / member | Meaning |
| --- | --- |
| `name` | fragment id in the gateway registry (required) |
| `src` | a fixed route; **omit it** and the fragment is *bound* — it follows the host's location and its navigations drive the host URL |
| `props` | set as a property (object), or a JSON attribute; structured-cloned across the realm |
| `state` | `idle \| loading \| ready \| error` |
| `reload()` | tear down and boot again from the network |

Events: `braid:ready`, `braid:error` (detail names the stage and a fix hint), `braid:event`
(fragment → host).

## How a fragment boots

1. The slot checks for content the gateway **pierced** in (a declarative shadow root containing
   `<braid-document>`). If present it adopts it — no fetch.
2. Otherwise it fetches `/__braid/doc/:id/<route>`, which the gateway prepares identically.
3. In parallel it creates a realm: a hidden iframe at `/__braid/realm/:id/<route>`, whose
   protocol version is verified (mismatch → named error, not a silent misbehavior).
4. The adapter named by the realm stub boots the fragment. Unknown adapter → named error;
   no adapter declared → compat.

## Realms

| Kind | URL | History | Used by |
| --- | --- | --- | --- |
| `compat-http` | `/__braid/realm/…` | initial load only, then `replaceState` | compat adapter |
| `contract-blob` | `blob:` | none, ever | contract adapters (none ship yet) |
| `sandbox` | third-party | — | not in this build |

Blob realms need no server and add zero history entries, but cannot maintain a location illusion
— which is exactly why compat mode uses http realms.

## The compat adapter

The default. It gives unmodified apps the illusion of owning the browser, using techniques
confined to the fragment's own realm and boundary:

- a document facade (Proxy spliced into the realm document's prototype chain, WebIDL-audited —
  unaudited API use warns in dev)
- per-node prototype stamping inside the fragment's DOM
- born-inert scripts, plus a shadow-root observer as an activation safety net
- realm window patches: constructor `hasInstance`, observer/CSSOM swaps, size getters, a history
  proxy for bound navigation

**The host page is never patched.** Verify with
`Node.prototype.appendChild.toString().includes('[native code]')`.

## Props, events, context

```ts
slot.props = { cartId };                       // host → fragment, reactive
slot.addEventListener('braid:event', …);        // fragment → host
braidContext.set('locale', 'en-US');            // host-published shared context
```

Everything crossing the boundary is structured-cloned; live objects are deliberately not shared.

## `FragmentEnv` (contract mode)

Defined and exported, but no contract adapters ship yet. It is the honest alternative to
emulation: `env.root`, `env.document`, `env.location`, `env.history`, `env.context`, `env.props`,
`env.emit`, `env.signal`. Compat fragments never see it.
