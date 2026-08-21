# @braid/cli

Run a composed application locally, with everything still live-reloading.

```bash
npx braid init                                  # write a starter braid.config.json
npx braid add checkout --port 4202 --pierce '/checkout/*'
npx braid dev                                   # one origin, everything composed
```

## `braid dev`

Starts the dev servers your config owns, waits for each to answer, then serves the gateway in
front of the shell on a single port. Requests Braid owns are handled by the gateway; everything
else is proxied to the shell untouched — **including websocket upgrades**, so a fragment's socket
goes to that fragment and the shell's to the shell. Each app rebuilds independently, exactly as
it does standalone.

```jsonc
{
  "port": 4000,
  "shell": { "port": 4200, "command": "npm start" },
  "fragments": [
    {
      "id": "billing",
      "endpoint": "http://localhost:4201/__braid/frag/billing",
      "dev": { "port": 4201, "command": "npm start --prefix ../billing" },
      "pierce": ["/billing", "/billing/*"]
    }
  ]
}
```

Ports are passed to child processes explicitly rather than inherited — a child that picks up a
stray `PORT` collides with another and the survivor answers for both, which looks like a Braid
bug and is not one.

## Dev servers need one setting

Vite-based dev servers (Angular's included) emit **absolute** module URLs — `/@fs/…`,
`/@vite/client`, pre-bundled deps — that ignore any proxy prefix, so rewriting HTML cannot
redirect them. Serve each fragment's dev server under its own namespace and give its endpoint the
matching path:

```jsonc
{ "servePath": "/__braid/frag/billing/" }                     // the fragment's dev server
{ "endpoint": "http://localhost:4201/__braid/frag/billing" }  // its entry in braid.config.json
```

The gateway treats an endpoint's path as a prefix, so the two line up. Production builds need
none of this.

**Known gap:** with this setup a fragment renders and rebuilds, but its Vite HMR *socket* does not
connect through a composed origin — a refresh picks up changes. Point the fragment dev server's
HMR at itself (`server.hmr.host` / `clientPort`) for true in-fragment HMR. The shell's HMR is
unaffected.

## Nx

```jsonc
// nx.json
{ "plugins": ["@braid/cli/nx"] }
```

Any project with a `braid.config.{json,mjs,js}` gains a `braid-dev` target — continuous,
uncached, described with the fragments it composes. Inference only; it never overrides a target
you wrote.

## Production

The gateway is middleware inside your own server in production and runs in *front* of it under
`braid dev`. Do not mount both:

```ts
if (!process.env['BRAID_DEV']) {
  app.use(toNodeMiddleware(gateway));
}
```

More: [dev workflow](../../skills/using-braid/references/dev-workflow.md) ·
[tooling roadmap](../../docs/braid-tooling.md)
