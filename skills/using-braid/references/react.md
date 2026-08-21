# @braid/react

```tsx
// entry file, module scope — before anything renders a fragment
initBraidReact();
```

```tsx
<BraidFragment name="billing" props={{ cartId }} onReady={({ fragmentId }) => …} />
```

## Why use the binding rather than the element

- **Props are DOM properties.** A raw custom element would stringify `props={{ cartId }}` into an
  attribute; the binding assigns the object, so it crosses the boundary structured-cloned.
- **Events are props.** `braid:ready` / `braid:error` / `braid:event` become `onReady` /
  `onError` / `onFragmentEvent`, attached through refs and torn down by an `AbortController`.
  Handlers are held in a ref, so re-rendering with a fresh inline arrow does not resubscribe.
- **JSX knows the element.** The `fragment-slot` intrinsic-element declaration ships with the
  binding rather than being re-declared in every host.

| Prop | Type |
| --- | --- |
| `name` | `string`, required |
| `src` | `string` — omit to keep the fragment bound to the host location |
| `props` | `Record<string, unknown>` |
| `onReady` | `({ fragmentId }) => void` |
| `onError` | `({ fragmentId, stage, fixHint?, error }) => void` |
| `onFragmentEvent` | `({ type, detail }) => void` |
| `onStateChange` | `(state) => void` |
| `ref` | `Ref<{ reload(): Promise<void>; state }>` |

## Host navigation

React has no single router, so the hook takes anything that changes once per navigation:

```tsx
useBraidHostNavigation(useLocation().key); // react-router
useBraidHostNavigation(useRouterState({ select: (s) => s.location.href })); // TanStack Router
```

It notifies from an effect — after commit, which is the only correct moment. Omit the hook if
every fragment on the page has an explicit `src`; nothing is bound, so nothing needs telling.

## SSR

`<BraidFragment>` renders its `<fragment-slot>` on the server, which is what the gateway pierces
into. The client must **hydrate** that markup (`hydrateRoot`, not `createRoot`) or React discards
the pierced content and a second realm boots to re-fetch the fragment — the React form of the
single most common Braid failure.

## Embedding a React app *as* a fragment

Needs none of this. Compat is the default adapter, so a React app is composed without importing
anything from Braid, without a build plugin, and without knowing it is embedded.
