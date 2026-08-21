# @braid/angular

```ts
bootstrapApplication(App, {
  providers: [provideRouter(routes), provideClientHydration(), provideBraid()],
});
```

```html
<braid-fragment name="billing" [props]="{ cartId: cartId() }" (ready)="onReady($event)" />
```

## Why use the binding rather than the element

- **No `CUSTOM_ELEMENTS_SCHEMA`** in your components — the schema is declared once inside the
  binding, so your templates keep strict element checking.
- **Typed inputs and outputs.** `props` is set as a DOM property (never a serialized attribute);
  `braid:ready` / `braid:error` / `braid:event` become `(ready)` / `(failed)` / `(fragmentEvent)`.
- **Correct router wiring.** `provideBraid()` subscribes to `NavigationEnd` and
  `NavigationSkipped`. Never `NavigationStart`: it fires *before* the URL changes, so fragments
  would be told about a location the page has not reached and would lag one navigation behind.
- **SSR-safe.** `provideBraid()` no-ops on the server, while the component still renders its
  `<fragment-slot>` into the SSR output — which is what the gateway pierces into.

| Member | Type |
| --- | --- |
| `name` | `string`, required |
| `src` | `string` — omit to keep the fragment bound to the host location |
| `props` | `Record<string, unknown>` |
| `(ready)` | `{ fragmentId }` |
| `(failed)` | `{ fragmentId, stage, fixHint?, error }` |
| `(fragmentEvent)` | `{ type, detail }` |
| `state()` | signal of `idle \| loading \| ready \| error` |
| `reload()` | `Promise<void>` |

## SSR requirements

**Hydration must be on in both bootstraps** — put `provideClientHydration()` in a shared
`appConfig` used by `main.ts` and `main.server.ts`. Configuring it on only one side silently does
nothing, and without it Angular discards the server-rendered DOM, destroying the slot the gateway
filled and booting a second realm to re-fetch the fragment.

Render per request rather than prerendering pierced routes:

```ts
export const serverRoutes: ServerRoute[] = [{ path: '**', renderMode: RenderMode.Server }];
```

A prerendered shell is a cached artifact with an empty slot — the fragment falls back to booting
on the client, which is what piercing exists to avoid.

## Verified to work alongside

`@defer (hydrate on interaction)` with `withIncrementalHydration()`: the block stays
server-rendered and dehydrated, downloads its chunk on interaction, hydrates, and replays the
triggering event — on the same page where a fragment boots into its own realm.

## Angular version notes (22)

- `AngularNodeAppEngine` validates the `Host` header; pass `allowedHosts` for local serving.
- The server bootstrap receives a `BootstrapContext` that must be passed through to
  `bootstrapApplication`. The type is not publicly exported; derive it with
  `Parameters<typeof bootstrapApplication>[2]`.
- Use `outputHashing` in any configuration you actually serve, or unhashed bundles get cached.
