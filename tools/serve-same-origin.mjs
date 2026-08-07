#!/usr/bin/env node
/**
 * Serves both demo builds from ONE origin, the way a real deployment does.
 *
 *   node tools/serve-same-origin.mjs [--port 4420]
 *
 *   http://localhost:4420/         → apps/prod-host
 *   http://localhost:4420/remote/  → apps/prod-remote
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
 */
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';

const args = process.argv.slice(2);
const portFlag = args.indexOf('--port');
const PORT = portFlag !== -1 ? Number(args[portFlag + 1]) : 4420;

const HOST_ROOT = resolve('dist/apps/prod-host/browser');
const REMOTE_ROOT = resolve('dist/apps/prod-remote/browser');
const REMOTE_PREFIX = '/remote';

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

const server = createServer(async (req, res) => {
  const { pathname } = new URL(req.url, `http://localhost:${PORT}`);

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

server.listen(PORT, () => {
  process.stdout.write(
    `\n  one origin, two deployments\n\n` +
      `  host    http://localhost:${PORT}/\n` +
      `  remote  http://localhost:${PORT}${REMOTE_PREFIX}/\n\n` +
      `  Storage is shared here — that is the whole point.\n\n`,
  );
});
