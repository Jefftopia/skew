/**
 * Serves the built remote Angular app — the fragment's origin.
 *
 * This stands in for however the remote team actually deploys: it is a plain static SPA server
 * with a history fallback, and it knows nothing about Braid. The gateway forwards
 * `/__braid/frag/billing/*` here with the namespace prefix stripped, so this server sees exactly
 * the paths it would serve if you opened it directly.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const ROOT = new URL('../../dist/apps/braid-poc-remote/browser/', import.meta.url).pathname;
const PORT = Number(process.env.PORT ?? 4501);

const MIME = {
  '.html': 'text/html;charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  const filePath = normalize(join(ROOT, pathname));

  if (!filePath.startsWith(ROOT)) {
    res.statusCode = 403;
    return res.end('forbidden');
  }

  try {
    const body = await readFile(filePath);
    res.setHeader('content-type', MIME[extname(filePath)] ?? 'application/octet-stream');
    res.end(body);
  } catch {
    // SPA history fallback: any unknown path is a client route, so serve the app shell
    try {
      const index = await readFile(join(ROOT, 'index.html'));
      res.setHeader('content-type', MIME['.html']);
      res.end(index);
    } catch {
      res.statusCode = 404;
      res.end('remote app not built — run: npx nx build braid-poc-remote');
    }
  }
}).listen(PORT, () => console.log(`braid poc remote (fragment origin) on http://localhost:${PORT}`));
