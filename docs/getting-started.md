# Getting started

Put a second application on a page you already own, without touching that
application's code.

This takes about ten minutes and assumes you have a host app that renders HTML
on the server, and a second app running somewhere on its own port. If you want
to see it working before you wire up your own, skip to
[Run the demo](#run-the-demo-first) at the bottom.

---

## 1. Install the gateway

The gateway is server-side. It sits in front of your host app and composes
fragments into the HTML as it streams past.

```sh
npm install @braidlabs/gateway
```

## 2. Mount it in front of your host

Register the app you want to compose in, and mount the gateway **first** — it
has to see the request before your host does.

```ts
// server.ts
import express from 'express';
import { createGateway } from '@braidlabs/gateway';
import { toNodeMiddleware } from '@braidlabs/gateway/node';

const app = express();

const gateway = createGateway({
  mode: 'production',
  registry: [
    {
      id: 'billing',
      endpoint: 'http://localhost:4201',
      pierce: ['/billing', '/billing/*'],
      timeoutMs: 1200,
    },
  ],
});

app.use(toNodeMiddleware(gateway));
app.use(hostAppRouter);

app.listen(3000);
```

Three fields do the work:

- **`id`** — the fragment's name. It addresses the fragment everywhere else, exactly.
- **`endpoint`** — where the fragment's own server lives.
- **`pierce`** — the page URLs this fragment appears on. Only that; it never decides
  where an asset request goes.

## 3. Install the client runtime

The runtime defines `<fragment-slot>` and boots each fragment's realm.

```sh
npm install @braidlabs/core
```

```ts
// main.ts — anywhere in your host's startup
import '@braidlabs/core';
```

## 4. Name the slot in your host's template

```html
<div class="billing-container">
  <h1>Account &amp; invoicing</h1>
  <fragment-slot name="billing"></fragment-slot>
</div>
```

## 5. Change nothing in the other app

This step is not a Braid step. The billing team builds and serves their
application exactly as they already do:

```sh
npm run build
npm run serve -- --port 4201
```

No bundler plugin, no shared-dependency negotiation, no webpack config. The
`compat` adapter is the default, so an unmodified Angular or React app runs as a
fragment with zero code changes.

---

## Check it worked

Load `/billing/invoices` and look for three things:

**The content is in the first response.** Not added by JavaScript afterwards:

```sh
curl -s http://localhost:3000/billing/invoices | grep -c 'fragment-slot'
```

**The gateway says what it composed.** A composed page carries a header listing
every fragment pierced into it, in order:

```sh
curl -sI http://localhost:3000/billing/invoices | grep x-braid-fragment-id
```

If a fragment is missing from the page, this header tells you whether the
gateway tried and failed, or never matched the URL at all.

**The fragment's own requests go through its namespace.** In the network tab you
will see `/__braid/frag/billing/main.js` rather than `/main.js`. The gateway
strips the prefix and forwards to billing's server, which sees the paths it
would serve standalone.

---

## When it does not work

Two problems account for most first attempts:

**The fragment renders, then flickers, and there are two realms per slot.** Your
host framework discarded the server-rendered DOM and rebuilt it. Enable
hydration on **both** the server and client bootstraps — configuring one side
silently does nothing.

**A widget is an empty shell, or 404s, on every page.** It is a screen when it
should be chrome. A widget's content lives at one fixed path, so it needs
`bound: false` and a `src`:

```jsonc
{ "id": "notifications", "bound": false, "src": "/panel", "pierce": ["/", "/*"] }
```

Everything else, by symptom, is in [failure modes](braid-failure-modes.md).
Read that before debugging anything.

---

## Run the demo first

If you would rather see it before wiring your own:

```sh
npm run braid:demo
```

Then open <http://localhost:4500/billing/invoices> — three frameworks on one
page, none of which imported the others. <http://localhost:4500/demo> is the
panel tour, where each panel makes one claim and shows its own evidence.

---

## Where to go next

- **[Braid, explained](braid-explained.md)** — every term used above, and one page
  load walked end to end. Read this next.
- **[Tutorial 1 — Compose without colliding](tutorials/01-braid.md)** — the same
  thing at depth, with realms, degradation, and a shell you build yourself.
- **[Failure modes](braid-failure-modes.md)** — what goes wrong in practice, by symptom.
- **[CDN and deployment](braid-cdn.md)** — what to cache, and where the gateway can run.
