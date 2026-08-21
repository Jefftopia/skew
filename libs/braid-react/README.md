# @braidlabs/react

The React binding for [Braid](../braid). A typed component over `<fragment-slot>`, and a hook that
tells bound fragments when the host has navigated.

```tsx
// entry file, module scope
import { initBraidReact } from '@braidlabs/react';
initBraidReact();
```

```tsx
import { BraidFragment } from '@braidlabs/react';

<BraidFragment name="billing" onReady={() => setLoaded(true)} />;
```

That is the whole host-side integration. The server side is a gateway registration; see the
[gateway README](../braid-gateway/README.md).

## What the binding buys you over the raw element

**Props are set as DOM properties, not attributes.** Writing `props={{ cartId }}` on a raw custom
element would stringify the object into an attribute. The binding assigns it as a property, so it
crosses the realm boundary structured-cloned and intact.

**Events are React props.** `braid:ready`, `braid:error`, and fragment-published `braid:event`
arrive as `onReady` / `onError` / `onFragmentEvent`, with listeners attached through refs and torn
down by an `AbortController`. Handlers live in a ref, so a re-render with a new inline arrow
function does not resubscribe every listener on the element.

**JSX knows `<fragment-slot>` exists.** The intrinsic-element declaration ships with the binding,
declared once, rather than in every host that renders a fragment.

```tsx
<BraidFragment
  name="checkout"
  props={{ cartId }}
  onReady={({ fragmentId }) => …}
  onError={({ stage, fixHint }) => …}
  onFragmentEvent={({ type, detail }) => …}
  onStateChange={setState}
/>
```

| Prop | Type | Notes |
| --- | --- | --- |
| `name` | `string`, required | the fragment id in the gateway registry |
| `src` | `string` | a fixed route; omit it and the fragment follows the host's location |
| `props` | `Record<string, unknown>` | structured-cloned across the realm boundary |
| `onReady` | `({ fragmentId }) => void` | the fragment booted |
| `onError` | `(BraidFragmentError) => void` | names the stage and the likely fix |
| `onFragmentEvent` | `({ type, detail }) => void` | fragment → host |
| `onStateChange` | `(FragmentSlotState) => void` | for your own placeholder UI |
| `ref` | `Ref<BraidFragmentHandle>` | `.reload()` and `.state` |

## Host navigation

Braid never patches the host's History API — host purity is an invariant — so bound fragments
learn about host navigation through a callback. React has no single router, so the hook takes
anything that changes once per navigation rather than coupling to one:

```tsx
useBraidHostNavigation(useLocation().key); // react-router
useBraidHostNavigation(useRouterState({ select: (s) => s.location.href })); // TanStack Router
```

It notifies from an effect, which runs *after* commit. That timing is the point: signalling before
the URL changes tells fragments about a location the page has not reached, leaving them a
navigation behind. Skip the hook entirely if every fragment on the page has an explicit `src`.

## SSR

`<BraidFragment>` renders its `<fragment-slot>` during server rendering, which is what lets the
gateway pierce the fragment's server-rendered markup into the page. Only the event wiring is
browser-only. As with any hydrated SSR app, the client must hydrate rather than re-render the
document — `hydrateRoot`, not `createRoot` — or React discards the slot the gateway just filled
and a second realm boots to re-fetch the fragment. See
[failure modes](../../docs/braid-failure-modes.md).

## React as a *fragment*

Nothing above is required to embed a React app into someone else's page — that direction needs no
Braid code in the React app at all, because compat is the default adapter. A React app composed
into an Angular shell is running in [`docs/braid-poc.md`](../../docs/braid-poc.md); its source
(`apps/braid-poc-react-remote`) contains no Braid import.
