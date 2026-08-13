import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { createGateway } from '@skewkit/braid-gateway';
import { toNodeMiddleware, toNodeUpgradeHandler } from '@skewkit/braid-gateway/node';
import type { ResolvedConfig } from './config.js';

/**
 * The development gateway: Braid in front of dev servers you keep running.
 *
 * The point is that **nothing loses live reload**. Requests Braid owns are served by the
 * gateway; everything else is proxied to the shell's dev server untouched, and websocket
 * upgrades are routed the same way — a fragment's HMR socket to that fragment, the shell's to
 * the shell. Each app keeps rebuilding and pushing reloads exactly as it does standalone,
 * while the browser sees one composed origin.
 */
export function createDevServer(config: ResolvedConfig) {
  const gateway = createGateway({
    // `dev` is a CLI concern (how to start it); the gateway only wants the manifest
    registry: config.fragments.map((fragment) => {
      const manifest = { ...fragment };
      delete manifest.dev;
      return manifest;
    }),
    mode: 'development',
    ...(config.gateway?.discovery ? { discovery: config.gateway.discovery } : {}),
  });

  const braid = toNodeMiddleware(gateway);
  const shellUrl = new URL(config.shell.url);

  const server = createServer((req, res) => {
    braid(req, res, () => proxyToShell(req, res, shellUrl));
  });

  // fragment sockets go to their fragment; anything else is the shell's own dev socket
  server.on(
    'upgrade',
    toNodeUpgradeHandler(gateway, (req, socket, head) => proxyUpgradeToShell(req, socket, head, shellUrl)),
  );

  return server;
}

function proxyToShell(req: IncomingMessage, res: ServerResponse, shellUrl: URL): void {
  const upstream = httpRequest(
    {
      host: shellUrl.hostname,
      port: shellUrl.port || 80,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: shellUrl.host },
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    },
  );

  upstream.on('error', (error) => {
    res.statusCode = 502;
    res.setHeader('content-type', 'text/plain;charset=utf-8');
    res.end(
      `braid dev: the shell at ${shellUrl.origin} did not answer.\n` +
        `Is it running? (${(error as Error).message})\n`,
    );
  });

  req.pipe(upstream);
}

function proxyUpgradeToShell(req: IncomingMessage, socket: Duplex, head: Buffer, shellUrl: URL): void {
  const upstream = httpRequest({
    host: shellUrl.hostname,
    port: shellUrl.port || 80,
    path: req.url,
    method: req.method,
    headers: { ...req.headers, host: shellUrl.host },
  });

  upstream.on('upgrade', (upstreamRes, upstreamSocket, upstreamHead) => {
    const headers = Object.entries(upstreamRes.headers)
      .flatMap(([name, value]) =>
        Array.isArray(value) ? value.map((entry) => `${name}: ${entry}`) : [`${name}: ${value}`],
      )
      .join('\r\n');

    socket.write(`HTTP/1.1 ${upstreamRes.statusCode} ${upstreamRes.statusMessage}\r\n${headers}\r\n\r\n`);
    if (upstreamHead?.length) socket.write(upstreamHead);

    upstreamSocket.on('error', () => socket.destroy());
    socket.on('error', () => upstreamSocket.destroy());
    upstreamSocket.pipe(socket).pipe(upstreamSocket);
  });

  upstream.on('error', () => socket.destroy());
  if (head?.length) upstream.write(head);
  upstream.end();
}
