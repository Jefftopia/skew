#!/usr/bin/env node
import { add, dev, init } from './lib/commands.js';

const USAGE = `braid — compose independently deployed frontends

  braid dev [--config <path>]     run the composed app locally, live reload intact
  braid init [--force]            write a starter braid.config.json
  braid add <id> [options]        register a fragment
      --endpoint <url>              where the fragment is served
      --port <n>                    dev port (implies http://localhost:<n>)
      --pierce <pattern>            page routes to server-render it into (repeatable)
`;

const [command, ...argv] = process.argv.slice(2);

const commands: Record<string, (argv: string[]) => Promise<number>> = { dev, init, add };
const run = command ? commands[command] : undefined;

if (!run) {
  process.stdout.write(USAGE);
  process.exit(command && command !== '--help' && command !== '-h' ? 1 : 0);
}

run(argv)
  .then((code) => process.exit(code))
  .catch((error) => {
    process.stderr.write(`braid: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
