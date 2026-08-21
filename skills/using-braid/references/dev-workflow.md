# Developing with Braid

## `braid dev`

```bash
npx braid init      # write a starter braid.config.json
npx braid add checkout --port 4202 --pierce '/checkout/*'
npx braid dev       # one origin, everything composed
```

```jsonc
// braid.config.json
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

`braid dev` starts the commands it owns, waits for each to answer, then serves the gateway in
front of the shell on one port. Requests Braid owns are handled by the gateway; everything else
is proxied to the shell untouched, **including websocket upgrades** — a fragment's socket to that
fragment, the shell's to the shell. Every app keeps rebuilding independently.

Logs are prefixed per process. Ports are passed to children explicitly rather than inherited,
because a child that inherits `PORT` silently collides with another.

## The one thing dev needs that production does not

**Serve each fragment's dev server under its own Braid namespace.** Dev servers built on Vite —
which includes Angular's — emit *absolute* module URLs (`/@fs/…`, `/@vite/client`, pre-bundled
deps) that ignore any proxy prefix. Rewriting HTML cannot fix that, because those URLs are
generated inside transformed JavaScript.

Two coordinated settings fix it:

```jsonc
// the fragment's dev server
{ "servePath": "/__braid/frag/billing/" }   // Angular; Vite calls this `base`
```
```jsonc
// the fragment's endpoint in braid.config.json — note the matching path
{ "endpoint": "http://localhost:4201/__braid/frag/billing" }
```

The gateway treats an endpoint's path as a prefix, so the two line up and every absolute URL the
dev server emits already lands in the right namespace. Production builds need none of this;
their URLs are re-rooted by the gateway.

**Known gap:** with this setup the fragment renders and rebuilds, but its Vite HMR *socket* does
not connect by default — Vite derives the socket URL from the page origin and its own port, and
neither matches through a composed origin. A browser refresh picks up fragment changes. To get
true HMR inside a fragment, point the fragment dev server's HMR at itself (`server.hmr.host` /
`clientPort` in Vite config). The shell's own HMR works untouched.

## Nx

```jsonc
// nx.json
{ "plugins": ["@braidlabs/cli/nx"] }
```

Every project with a `braid.config.{json,mjs,js}` gains a `braid-dev` target, marked continuous
and uncached, with a description listing the fragments it composes. `nx run shell:braid-dev` runs
the composed application; `nx show project shell` documents it; the config file is a normal input,
so affected-detection works.

Inference only — it adds targets and never overrides ones you wrote.

## Production differs in one line

The gateway is middleware inside your own server in production, and runs *in front* of it under
`braid dev`. Do not mount both, or every fragment is composed twice:

```ts
if (!process.env['BRAID_DEV']) {
  app.use(toNodeMiddleware(gateway));
}
```
