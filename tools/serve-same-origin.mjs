#!/usr/bin/env node
/**
 * Serves both demo builds from ONE origin, the way a real deployment does.
 *
 *   node tools/serve-same-origin.mjs [--port 4420] [--api-port 3333]
 *
 *   http://localhost:4420/           → apps/prod-host
 *   http://localhost:4420/remote/    → apps/prod-remote
 *   http://localhost:4420/api/…      → proxied to the NestJS API
 *   ws://localhost:4420/ws/ticker    → proxied to the same API
 *
 * The default `demo:prod:serve` puts the two apps on separate ports, which
 * makes them separate *origins* — and the Same-Origin Policy then partitions
 * `localStorage`, so the remote opened on its own sees an empty bucket. That is
 * honest about what two ports mean, but it is not how these get deployed.
 *
 * In production a host and its remotes almost always sit behind one reverse
 * proxy, on one origin, split by path. Nothing about federation requires
 * separate origins — the host resolves the remote by URL, and a relative URL is
 * a URL. Same origin means storage, cookies and the `storage` event are simply
 * shared, with no bridging needed.
 *
 * Two builds, unchanged, mounted at different paths. Deploy them independently;
 * they still skew. Everything the other mode demonstrates still happens here —
 * except the storage partition, which was never the interesting part.
 *
 * The API is proxied rather than re-hosted for the same reason: it is its own
 * deployment (`npm run api`, on its own port), and this server just forwards
 * to it — including the raw TCP pipe needed for the WebSocket upgrade, since
 * an HTTP proxy doesn't get that for free.
 */
import { createServer, request as httpRequest } from 'node:http';
import { connect as netConnect } from 'node:net';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';

const args = process.argv.slice(2);
const portFlag = args.indexOf('--port');
const PORT = portFlag !== -1 ? Number(args[portFlag + 1]) : 4420;
const apiPortFlag = args.indexOf('--api-port');
const API_PORT = apiPortFlag !== -1 ? Number(args[apiPortFlag + 1]) : 3333;

const HOST_ROOT = resolve('dist/apps/prod-host/browser');
const REMOTE_ROOT = resolve('dist/apps/prod-remote/browser');
const REMOTE_PREFIX = '/remote';
const API_PREFIX = '/api';
const WS_PATH = '/ws/ticker';

/**
 * The federation manifest for *this* topology, synthesized rather than built in.
 *
 * The host's bundle ships a manifest pointing at `http://localhost:4411`. Same
 * bundle, different deployment, different remote URL — which is exactly why
 * Native Federation reads the manifest at runtime instead of baking remote
 * locations into the build. Overriding it here is the whole mechanism working
 * as intended, not a workaround.
 */
const MANIFEST = JSON.stringify(
  { 'prod-remote': `${REMOTE_PREFIX}/remoteEntry.json` },
  null,
  2,
);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * Resolves a URL path inside a root, refusing anything that escapes it.
 *
 * `normalize` collapses `..` segments; the prefix check then rejects what is
 * left if it still points outside. Skipping this would serve any file on the
 * machine to anyone who can reach the port.
 */
function safeJoin(root, urlPath) {
  const decoded = decodeURIComponent(urlPath);
  const candidate = resolve(join(root, normalize(decoded)));
  if (candidate !== root && !candidate.startsWith(root + sep)) return null;
  return candidate;
}

async function fileAt(path) {
  if (!path) return null;
  try {
    const info = await stat(path);
    return info.isFile() ? path : null;
  } catch {
    return null;
  }
}

function send(res, status, body, type) {
  res.writeHead(status, {
    'Content-Type': type,
    // The redeploy scenarios depend on the browser actually re-fetching.
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendFile(res, path) {
  res.writeHead(200, {
    'Content-Type': MIME[extname(path)] ?? 'application/octet-stream',
    'Cache-Control': 'no-store',
  });
  createReadStream(path).pipe(res);
}

/**
 * Serves the remote's own `index.html` with its base href rewritten.
 *
 * The remote is built with `<base href="/">` because it is also servable at the
 * root of its own origin. Mounted under `/remote/`, that base would send every
 * relative asset request — and `initFederation('./remoteEntry.json')` — to the
 * host's root instead.
 *
 * Rewriting one attribute at the edge is what a reverse proxy does (nginx
 * `sub_filter`, a CDN function) and it keeps **one build artifact** working at
 * both mount points. The alternative is rebuilding the remote with
 * `--base-href /remote/`, which produces a bundle that only works there.
 */
async function sendRemoteIndex(res) {
  const path = await fileAt(join(REMOTE_ROOT, 'index.html'));
  if (!path) return send(res, 404, 'remote build not found', MIME['.txt']);
  const { readFile } = await import('node:fs/promises');
  const html = (await readFile(path, 'utf8')).replace(
    /<base href="\/">/,
    `<base href="${REMOTE_PREFIX}/">`,
  );
  send(res, 200, html, MIME['.html']);
}

/**
 * Forwards an HTTP request to the API process, byte for byte.
 *
 * Not a library `http-proxy` — this is a demo tool and the whole request is a
 * dozen lines of `node:http`. `res.writeHead` copies the upstream's status and
 * headers verbatim, so the API's own `Content-Type` (and its CORS headers,
 * which do nothing here but are harmless) pass straight through.
 */
function proxyHttp(req, res) {
  const upstream = httpRequest(
    {
      host: 'localhost',
      port: API_PORT,
      path: req.url,
      method: req.method,
      headers: req.headers,
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    },
  );
  upstream.on('error', () =>
    send(res, 502, 'api unreachable — is `npm run api` running?', MIME['.txt']),
  );
  req.pipe(upstream);
}

const server = createServer(async (req, res) => {
  const { pathname } = new URL(req.url, `http://localhost:${PORT}`);

  if (pathname === API_PREFIX || pathname.startsWith(`${API_PREFIX}/`)) {
    return proxyHttp(req, res);
  }

  // The topology-specific manifest wins over the one baked into the bundle.
  if (pathname === '/federation.manifest.json') {
    return send(res, 200, MANIFEST, MIME['.json']);
  }

  // Without the trailing slash every relative URL on the page resolves one
  // level too high.
  if (pathname === REMOTE_PREFIX) {
    res.writeHead(302, { Location: `${REMOTE_PREFIX}/` });
    return res.end();
  }

  if (pathname.startsWith(`${REMOTE_PREFIX}/`)) {
    const rest = pathname.slice(REMOTE_PREFIX.length) || '/';
    if (rest === '/') return sendRemoteIndex(res);
    const file = await fileAt(safeJoin(REMOTE_ROOT, rest));
    // SPA fallback: an extension-less path is a route, not a missing asset.
    if (!file)
      return extname(rest)
        ? send(res, 404, 'not found', MIME['.txt'])
        : sendRemoteIndex(res);
    return sendFile(res, file);
  }

  const file = await fileAt(safeJoin(HOST_ROOT, pathname));
  if (file) return sendFile(res, file);
  if (extname(pathname)) return send(res, 404, 'not found', MIME['.txt']);

  const index = await fileAt(join(HOST_ROOT, 'index.html'));
  if (!index) return send(res, 404, 'host build not found', MIME['.txt']);
  return sendFile(res, index);
});

/**
 * Proxies the WebSocket upgrade for `/ws/ticker`.
 *
 * An ordinary HTTP proxy doesn't get this for free: the upgrade handshake
 * happens once, over the same TCP connection the client then keeps open for
 * the life of the socket, and neither `http.request` nor `res.writeHead` has
 * a concept of "now hand this connection to someone else." So this opens a
 * raw TCP connection to the API, replays the original request line and
 * headers onto it by hand (what the client sent, minus nothing), and then
 * pipes the two sockets together in both directions — at that point neither
 * side can tell a proxy is there.
 */
server.on('upgrade', (req, clientSocket, head) => {
  const { pathname } = new URL(req.url, `http://localhost:${PORT}`);
  if (pathname !== WS_PATH) {
    clientSocket.destroy();
    return;
  }

  const upstream = netConnect(API_PORT, 'localhost', () => {
    const headerLines = Object.entries(req.headers).map(
      ([k, v]) => `${k}: ${v}`,
    );
    upstream.write(
      `GET ${req.url} HTTP/1.1\r\n${headerLines.join('\r\n')}\r\n\r\n`,
    );
    if (head?.length) upstream.write(head);
    clientSocket.pipe(upstream);
    upstream.pipe(clientSocket);
  });

  upstream.on('error', () => clientSocket.destroy());
  clientSocket.on('error', () => upstream.destroy());
});

server.listen(PORT, () => {
  process.stdout.write(
    `\n  one origin, two deployments\n\n` +
      `  host    http://localhost:${PORT}/\n` +
      `  remote  http://localhost:${PORT}${REMOTE_PREFIX}/\n` +
      `  api     http://localhost:${PORT}${API_PREFIX}/  (proxied to :${API_PORT})\n\n` +
      `  Storage is shared here — that is the whole point.\n` +
      `  The API must be running separately: npm run api\n\n`,
  );
});
