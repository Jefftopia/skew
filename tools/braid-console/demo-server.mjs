/**
 * Serves the built console from a real gateway, same origin.
 *
 * That is both the simplest way to see it working and a realistic deployment: the console is a
 * static bundle, and the gateway is already an HTTP server in front of the origin.
 *
 * `tsx` is not a workspace dependency, and Node's own type stripping cannot resolve the workspace's
 * `.js`-suffixed source imports or its `@skewkit/*` path aliases — so both are handed to `tsx` via
 * npx, pointed at the tsconfig that defines them:
 *
 *   TSX_TSCONFIG_PATH=tsconfig.base.json npx tsx tools/braid-console/demo-server.mjs
 *   GATEWAY_MODE=production TSX_TSCONFIG_PATH=tsconfig.base.json npx tsx tools/braid-console/demo-server.mjs
 *
 * Build the console first: `nx build-app braid-console`.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGateway } from '../../libs/braid-gateway/src/index.ts';
import { toNodeMiddleware } from '../../libs/braid-gateway/src/node.ts';
import { createRegistryApi, createSnapshot, memorySnapshotStore } from '../../libs/braid-registry/src/index.ts';

// Resolved from this file, not the cwd, so the server runs correctly from any directory.
const DIST = fileURLToPath(new URL('../../dist/apps/braid-console', import.meta.url));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

const REGISTRY = [
  {
    id: 'billing',
    endpoint: 'http://localhost:9101',
    pierce: ['/billing/*'],
    title: 'Billing',
    description: 'Invoices and payment methods.',
    tags: ['finance', 'core'],
  },
  {
    id: 'reviews',
    endpoint: 'http://localhost:9102',
    pierce: ['/billing/*'],
    title: 'Customer reviews',
    description: 'A React 19 app composed into the billing page.',
    tags: ['react'],
  },
  {
    id: 'rating',
    endpoint: 'http://localhost:9103',
    adapter: 'custom-element',
    entry: '/star-rating.js',
    element: 'star-rating',
    title: 'Star rating',
    description: 'A framework-free web component.',
    tags: ['widget'],
  },
  {
    id: 'payroll',
    endpoint: 'http://localhost:9104',
    pierce: ['/payroll/*'],
    title: 'Payroll',
    description: 'Restricted — listed, but not loadable without the payroll role.',
    tags: ['finance'],
    access: { fetch: { roles: ['payroll'] } },
  },
];

const gateway = createGateway({
  mode: process.env.GATEWAY_MODE === 'production' ? 'production' : 'development',
  discovery: { includeEndpoints: false },
  registry: REGISTRY,
  principal: () => ({ roles: ['finance'], scopes: [] }),
});

// Seeded with the same manifests, so the editor has a pinned snapshot to branch from.
const store = memorySnapshotStore();
const seeded = await createSnapshot({ manifests: REGISTRY, labels: { by: 'demo' } });
await store.put(seeded);
await store.setHead(seeded.id);

const registryApi = createRegistryApi({
  store,
  // A real deployment wires this to its own session. Allowing everything is fine for a demo, and
  // would be remote control of the registry in production — which is why there is no permissive
  // default and an unconfigured API refuses writes.
  authorize: () => true,
});

const middleware = toNodeMiddleware(gateway);

createServer((request, response) => {
  middleware(request, response, async () => {
    const apiResponse = await registryApi.handle(await toWebRequest(request));
    if (apiResponse) {
      response.writeHead(apiResponse.status, Object.fromEntries(apiResponse.headers));
      response.end(Buffer.from(await apiResponse.arrayBuffer()));
      return;
    }

    // Strip the query *before* testing for the root, so `/?x=1` still serves the app rather than
    // falling through to a read of the dist directory itself.
    const pathname = (request.url ?? '/').split('?')[0];
    const path = !pathname || pathname === '/' ? '/index.html' : pathname;
    try {
      const body = await readFile(join(DIST, path));
      response.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' });
      response.end(body);
    } catch {
      response.writeHead(404).end('not found');
    }
  });
}).listen(9100, () => console.log('console demo → http://localhost:9100'));

async function toWebRequest(request) {
  const url = new URL(request.url, `http://${request.headers.host ?? 'localhost:9100'}`);
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';

  const chunks = [];
  if (hasBody) for await (const chunk of request) chunks.push(chunk);

  return new Request(url, {
    method: request.method,
    headers: Object.entries(request.headers).filter(([, value]) => typeof value === 'string'),
    ...(hasBody && chunks.length > 0 ? { body: Buffer.concat(chunks) } : {}),
  });
}
