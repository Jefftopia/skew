import {
  AngularNodeAppEngine,
  createNodeRequestHandler,
  isMainModule,
  writeResponseToNodeResponse,
} from '@angular/ssr/node';
import express from 'express';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The notifications app's own server. No Braid anywhere in it.
 *
 * It answers `/panel` with server-rendered HTML exactly as it answers `/` — the gateway is just
 * another client asking for a page, which is what makes "deployed on its own schedule" true rather
 * than aspirational.
 */
const serverDistFolder = dirname(fileURLToPath(import.meta.url));
const browserDistFolder = resolve(serverDistFolder, '../browser');

const app = express();
const angularApp = new AngularNodeAppEngine({ allowedHosts: ['localhost', '127.0.0.1'] });

/**
 * A deliberately controllable delay, for the resilience checks.
 *
 * The POC has to show that a slow widget degrades instead of holding every page — and a widget that
 * is always fast cannot demonstrate a timeout budget any more than a server that always succeeds
 * can demonstrate a queue.
 */
let delayMs = Number(process.env['NOTIFICATIONS_DELAY_MS'] ?? 0);

app.post('/__delay/:ms', (request, response) => {
  delayMs = Math.max(0, Math.min(Number(request.params.ms) || 0, 10_000));
  response.json({ delayMs });
});

app.use((_request, _response, next) => {
  if (delayMs <= 0) return next();
  setTimeout(next, delayMs);
});

// No max-age: this POC builds without filename hashing, so a long-lived cache would serve a stale
// bundle after every rebuild.
app.use(express.static(browserDistFolder, { etag: true, maxAge: 0, index: false, redirect: false }));

app.use((req, res, next) => {
  angularApp
    .handle(req)
    .then((response) => (response ? writeResponseToNodeResponse(response, res) : next()))
    .catch(next);
});

if (isMainModule(import.meta.url)) {
  const port = Number(process.env['PORT'] ?? 4505);
  app.listen(port, () => {
    console.log(`braid poc notifications (SSR) listening on http://localhost:${port}`);
  });
}

export const reqHandler = createNodeRequestHandler(app);
