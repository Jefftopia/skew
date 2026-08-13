import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { findConfig, loadConfig, type BraidConfig } from './config.js';
import { createDevServer } from './dev-server.js';
import { startTarget, stopAll, waitForTarget, type ManagedProcess } from './processes.js';

const BOLD = '[1m';
const DIM = '[2m';
const RESET = '[0m';

/**
 * `braid dev` — run the composed application locally, with everything still live-reloading.
 *
 * Starts whatever dev servers the config owns, waits for them, then serves the gateway in front
 * of the shell on one port. Fragment requests and fragment websockets route to fragments; the
 * shell keeps its own dev server and its own HMR socket. Nothing is bundled together, so each
 * app rebuilds independently exactly as it does standalone.
 */
export async function dev(argv: string[]): Promise<number> {
  const configPath = await resolveConfigPath(argv);
  if (!configPath) return 1;

  const config = await loadConfig(configPath);
  const managed: ManagedProcess[] = [];

  const shutdown = () => stopAll(managed);
  process.on('SIGINT', () => {
    shutdown();
    process.exit(0);
  });
  process.on('SIGTERM', shutdown);
  process.on('exit', shutdown);

  const targets = [
    { label: 'shell', target: config.shell },
    ...config.fragments.filter((fragment) => fragment.dev).map((fragment) => ({ label: fragment.id, target: fragment.dev! })),
  ];

  targets.forEach(({ label, target }, index) => {
    const managedProcess = startTarget(label, target, index);
    if (managedProcess) managed.push(managedProcess);
  });

  for (const { label, target } of targets) {
    if (!(await waitForTarget(target))) {
      process.stderr.write(`braid dev: ${label} never came up at ${target.url}\n`);
      shutdown();
      return 1;
    }
  }

  const server = createDevServer(config);

  await new Promise<void>((ready) => server.listen(config.port, ready));

  process.stdout.write(
    `\n${BOLD}braid dev${RESET} → ${BOLD}http://localhost:${config.port}${RESET}\n` +
      `${DIM}  shell     ${RESET}${config.shell.url}\n` +
      config.fragments
        .map((fragment) => `${DIM}  ${fragment.id.padEnd(10)}${RESET}${String(fragment.endpoint)}\n`)
        .join('') +
      `${DIM}  live reload is preserved for the shell and every fragment${RESET}\n\n`,
  );

  await new Promise(() => undefined); // run until interrupted
  return 0;
}

/** `braid init` — write a starter config next to the shell you already have. */
export async function init(argv: string[]): Promise<number> {
  const target = resolve(process.cwd(), 'braid.config.json');
  const force = argv.includes('--force');

  if (!force && (await findConfig(process.cwd()))) {
    process.stderr.write(`braid init: a braid config already exists. Pass --force to overwrite.\n`);
    return 1;
  }

  const starter: BraidConfig = {
    port: 4000,
    shell: { port: 4200, command: 'npm start' },
    fragments: [
      {
        id: 'example',
        dev: { port: 4201, command: 'npm start --prefix ../example-app' },
        pierce: ['/example', '/example/*'],
      },
    ],
  };

  await writeFile(target, `${JSON.stringify(starter, null, 2)}\n`);
  process.stdout.write(
    `braid init: wrote ${target}\n` +
      `  1. point "shell" at the app that hosts fragments\n` +
      `  2. list each fragment under "fragments"\n` +
      `  3. run: braid dev\n`,
  );
  return 0;
}

/** `braid add <id> --endpoint <url> [--pierce <pattern>]` — register a fragment. */
export async function add(argv: string[]): Promise<number> {
  const [id] = argv.filter((argument) => !argument.startsWith('--'));
  if (!id) {
    process.stderr.write('braid add: usage: braid add <fragment-id> [--endpoint <url>] [--port <n>] [--pierce <pattern>]\n');
    return 1;
  }

  const configPath = await findConfig();
  if (!configPath) {
    process.stderr.write('braid add: no braid config found. Run `braid init` first.\n');
    return 1;
  }
  if (!configPath.endsWith('.json')) {
    process.stderr.write(`braid add: ${configPath} is not JSON; add the fragment by hand.\n`);
    return 1;
  }

  const config = JSON.parse(await readFile(configPath, 'utf8')) as BraidConfig;
  config.fragments ??= [];

  if (config.fragments.some((fragment) => fragment.id === id)) {
    process.stderr.write(`braid add: "${id}" is already registered in ${configPath}\n`);
    return 1;
  }

  const endpoint = flag(argv, '--endpoint');
  const port = flag(argv, '--port');
  const pierce = argv.reduce<string[]>((patterns, argument, index) => {
    if (argument === '--pierce' && argv[index + 1]) patterns.push(argv[index + 1]);
    return patterns;
  }, []);

  if (!endpoint && !port) {
    process.stderr.write('braid add: pass --endpoint <url> or --port <n>\n');
    return 1;
  }

  config.fragments.push({
    id,
    ...(endpoint ? { endpoint } : {}),
    ...(port ? { dev: { port: Number(port) } } : {}),
    ...(pierce.length ? { pierce } : {}),
  });

  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  process.stdout.write(
    `braid add: registered "${id}" in ${configPath}\n` +
      `  host it with: <braid-fragment name="${id}" />   (or <fragment-slot name="${id}">)\n`,
  );
  return 0;
}

function flag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
}

async function resolveConfigPath(argv: string[]): Promise<string | null> {
  const explicit = flag(argv, '--config');
  if (explicit) return resolve(process.cwd(), explicit);

  const found = await findConfig();
  if (!found) {
    process.stderr.write('braid: no braid.config.{json,mjs} found. Run `braid init` to create one.\n');
  }
  return found;
}
