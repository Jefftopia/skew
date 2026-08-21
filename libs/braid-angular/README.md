# @braid/angular

The Angular binding for [Braid](../braid). A typed component over `<fragment-slot>`, and one
provider that wires host navigation to the Angular router.

```ts
import { provideBraid } from '@braid/angular';

bootstrapApplication(App, {
  providers: [provideRouter(routes), provideClientHydration(), provideBraid()],
});
```

```html
<braid-fragment name="billing" (ready)="onReady($event)" />
```

That is the whole host-side integration. The server side is a gateway registration; see the
[gateway README](../braid-gateway/README.md).

## What the binding buys you over the raw element

**No `CUSTOM_ELEMENTS_SCHEMA` in your components.** The schema is declared once inside the
binding, so your templates keep strict element checking instead of opting out of it wherever a
fragment appears.

**Typed inputs and outputs.** `props` is an object set as a DOM property — not a JSON-encoded
attribute — and events arrive as Angular outputs rather than `CustomEvent` listeners you wire and
unwire by hand.

```html
<braid-fragment
  name="checkout"
  [props]="{ cartId: cartId() }"
  (ready)="onReady($event)"
  (failed)="onFailed($event)"
  (fragmentEvent)="onFragmentEvent($event)"
/>
```

| Member | Type | Notes |
| --- | --- | --- |
| `name` | `string`, required | the fragment id in the gateway registry |
| `src` | `string` | a fixed route; omit it and the fragment follows the host's location |
| `props` | `Record<string, unknown>` | structured-cloned across the realm boundary |
| `(ready)` | `{ fragmentId }` | the fragment booted |
| `(failed)` | `BraidFragmentError` | names the stage and the likely fix |
| `(fragmentEvent)` | `{ type, detail }` | fragment → host |
| `state()` | signal of `'idle' \| 'loading' \| 'ready' \| 'error'` | for your own placeholder UI |
| `reload()` | `Promise<void>` | tears down and boots again from the network |

**Correct router wiring.** `provideBraid()` subscribes to `NavigationEnd` and `NavigationSkipped`
— never `NavigationStart`, which fires *before* the URL changes and would leave bound fragments a
navigation behind. This is easy to get wrong by hand and the reason the provider exists.

**SSR-safe.** `provideBraid()` does nothing on the server, but the component still renders its
`<fragment-slot>` into the SSR output — which is exactly what the gateway needs in order to
pierce the fragment's server-rendered markup into the page.

## Requirements

Hydration must be enabled on both bootstraps (`provideClientHydration()` in a shared config).
Without it Angular discards the server-rendered DOM and re-creates it, destroying the slot the
gateway just filled and booting a second realm to re-fetch the fragment. See
[failure modes](../../docs/braid-failure-modes.md).

A working example — an SSR host composing a separately deployed Angular app, with routing across
the boundary — is in [`docs/braid-poc.md`](../../docs/braid-poc.md).
