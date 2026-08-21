# Braid tutorials

Hands-on, step-by-step introductions to each package. Every tutorial builds
something small and real, uses only public API, and ends with the failure it
protects you from — reproduced, not described.

Tutorials 1–6 take one package at a time. **Tutorial 7 is the one to read if you
are new and want to build something**: it uses the whole data layer in the order
you would actually build it, rather than feature by feature.

| # | Tutorial | Package | You will build |
| - | -------- | ------- | -------------- |
| 1 | [Version the data, not the deploy](01-core.md) | `@braid/skew` | A draft schema that survives three shape changes, migrates in both directions, and refuses dishonestly-shaped data |
| 2 | [Give your build a name](02-build.md) | `@braid/build` | A stamped build identity, a served manifest, a stale-origin detector, and generated frozen types |
| 3 | [Versioned stores, the Angular way](03-angular-core.md) | `@braid/angular-core` | A draft editor on DI + Signals with zero flicker and typed failure states |
| 4 | [One graph, durable writes](04-angular-data.md) | `@braid/angular-data` | A normalized fund list with optimistic, outbox-durable order submission |
| 5 | [Compose without colliding](05-braid.md) | `@braid/gateway` · `@braid/core` | An enterprise microfrontend shell with server-side piercing, isolated iframe realms, and zero-blast-radius degradation |
| 6 | [Client storage that survives a reload](06-data-storage.md) | `@braid/data` | A framework-free cache on IndexedDB — shared across apps, invalidated by tag, with a durable queue for writes the network never took |
| 7 | [Build a storefront, end to end](07-storefront.md) | `@braid/data` | The whole layer in build order — guest and customer partitions, a shared catalogue, orders that survive the network dropping, a shipping event pushed from the server, and a sign-out that destroys it all |

**Read them in the demo.** These pages are also served inside the federated
demo apps — the remote exposes a `./Tutorials` module and the host routes to
it at `/tutorials`, so the tutorials themselves cross the same deployment
boundary they teach about:

```sh
npm run demo:prod        # host → http://localhost:4410/tutorials
```

Screenshots are captured from that demo. When a step says "watch the
inspector", the Basics tab of the running host is the best companion — every
claim here can be reproduced there with a click.
