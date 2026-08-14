import { AngularNodeAppEngine, createNodeRequestHandler, isMainModule, writeResponseToNodeResponse } from '@angular/ssr/node';
import { createGateway } from '@skewkit/braid-gateway';
import { toNodeMiddleware } from '@skewkit/braid-gateway/node';
import express from 'express';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const serverDistFolder = dirname(fileURLToPath(import.meta.url));
const browserDistFolder = resolve(serverDistFolder, '../browser');

const app = express();

// Angular 22 validates the Host header against an allow-list (SSRF hardening). This POC is
// served from localhost, so it has to be named explicitly.
const angularApp = new AngularNodeAppEngine({ allowedHosts: ['localhost', '127.0.0.1'] });

/**
 * The Braid gateway, in front of the host's own SSR.
 *
 * Two jobs, both invisible to the Angular app behind it:
 *
 * 1. `/__braid/frag/billing/*` is routed to the remote app by id — its realm stub, its
 *    JavaScript, its stylesheet, its data. The remote never learns it is embedded.
 * 2. A document request for a `pierce` route is composed: the gateway fetches the host's SSR
 *    output and the remote's HTML concurrently and interleaves them, so the remote's markup is
 *    inside `<fragment-slot>` in the very first response — no client round trip to fill it.
 */
const gateway = createGateway({
  registry: [
    {
      id: 'billing',
      // no `adapter` — compat is the default, which is what lets a stock Angular app be a
      // fragment with zero code changes
      endpoint: process.env['BRAID_REMOTE_ORIGIN'] ?? 'http://localhost:4501',
      pierce: ['/billing', '/billing/*'],
      title: 'Billing',
      description: 'Invoices and billing settings, deployed independently of the shell.',
      tags: ['finance'],
    },

    /**
     * A React app, composed into an Angular page. No adapter declared, so it gets compat — the
     * same default that made the Angular remote work, and the reason a fragment's framework is
     * the gateway's business only insofar as it names an endpoint.
     */
    {
      id: 'reviews',
      endpoint: process.env['BRAID_REACT_ORIGIN'] ?? 'http://localhost:4502',
      pierce: ['/billing', '/billing/*'],
      title: 'Customer reviews',
      description: 'A React 19 application running in its own realm.',
      tags: ['feedback'],
    },

    /**
     * A plain custom element. `custom-element` is a *contract* adapter: no document facade, no
     * window patches — the fragment gets a mount point, its props, and a teardown signal.
     * `events` is what the adapter republishes to the host as `braid:event`.
     */
    {
      id: 'rating',
      endpoint: process.env['BRAID_WIDGET_ORIGIN'] ?? 'http://localhost:4503',
      adapter: 'custom-element',
      entry: '/star-rating.js',
      element: 'star-rating',
      events: { 'rating:change': { detail: 'object' } },
      title: 'Star rating',
      description: 'A framework-free web component, mounted through the contract adapter.',
      tags: ['widget'],
    },
  ],
  mode: 'development',
  // `GET /__braid/registry` — in development this lists everything, endpoints included
  discovery: {},
});

/**
 * In production the gateway is middleware inside this server. Under `braid dev` it runs *in
 * front* of this server instead, so the app must not mount a second one — a doubly-pierced page
 * would carry two copies of every fragment.
 */
if (!process.env['BRAID_DEV']) {
  app.use(toNodeMiddleware(gateway));
}

// The host's own static assets. No max-age: this POC builds without filename hashing, so a
// long-lived cache would serve a stale bundle after every rebuild.
app.use(
  express.static(browserDistFolder, {
    etag: true,
    maxAge: 0,
    index: false,
    redirect: false,
  }),
);

// everything else is rendered by Angular — the gateway pierces this response when the route
// matches a fragment's `pierce` patterns
app.use((req, res, next) => {
  angularApp
    .handle(req)
    .then((response) => (response ? writeResponseToNodeResponse(response, res) : next()))
    .catch(next);
});

if (isMainModule(import.meta.url)) {
  const port = Number(process.env['PORT'] ?? 4500);
  app.listen(port, () => {
    console.log(`braid poc host (SSR + gateway) listening on http://localhost:${port}`);
  });
}

export const reqHandler = createNodeRequestHandler(app);
