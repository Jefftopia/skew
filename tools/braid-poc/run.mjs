/**
 * One command to run the POC: builds both apps, starts the remote's origin and the host's SSR
 * server, and waits until both answer.
 *
 * Host  → http://localhost:4500  (Angular SSR + the Braid gateway in front of it)
 * Remote→ http://localhost:4501  (a stock Angular SPA, reached only through the gateway)
 */
import { spawn } from 'node:child_process';

const WORKSPACE = new URL('../../', import.meta.url).pathname;

const HOST_PORT = 4500;
const REMOTE_PORT = 4501;

function run(command, args, options = {}) {
  return spawn(command, args, { cwd: WORKSPACE, stdio: 'inherit', shell: false, ...options });
}

/**
 * Children get their port explicitly. Inheriting `PORT` from whatever launched this script
 * would silently point both servers at the same port — the second one dies, and the survivor
 * answers for both, which looks like a Braid bug and is not one.
 */
function runServer(script, port) {
  return run('node', [script], { env: { ...process.env, PORT: String(port) } });
}

function runToCompletion(command, args) {
  return new Promise((resolve, reject) => {
    run(command, args).on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} ${args.join(' ')} exited with ${code}`)),
    );
  });
}

async function waitFor(url, label) {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      await fetch(url);
      console.log(`✔ ${label} ready at ${url}`);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error(`${label} never came up at ${url}`);
}

console.log('building the remote and host apps…');
await runToCompletion('npx', ['nx', 'run-many', '-t', 'build', '-p', 'braid-poc-remote', 'braid-poc-host']);

const remote = runServer('tools/braid-poc/serve-remote.mjs', REMOTE_PORT);
const host = runServer('dist/apps/braid-poc-host/server/server.mjs', HOST_PORT);

for (const [name, child] of [
  ['remote', remote],
  ['host', host],
]) {
  child.on('exit', (code) => {
    if (code !== 0 && code !== null) console.error(`✘ the ${name} server exited with code ${code}`);
  });
}

const shutdown = () => {
  remote.kill();
  host.kill();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('exit', shutdown);

await waitFor(`http://localhost:${REMOTE_PORT}/`, 'remote (fragment origin)');
await waitFor(`http://localhost:${HOST_PORT}/`, 'host (SSR + gateway)');

console.log(
  `\nOpen http://localhost:${HOST_PORT}/billing/invoices — the billing UI is a separate Angular app.\n`,
);
