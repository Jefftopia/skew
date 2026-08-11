#!/usr/bin/env node
import { generateContractFile } from '../lib/contract-gen.js';

/**
 * skew-contract — tooling for contract documents.
 *
 *   skew-contract gen --in contracts/portfolio-fund.json \
 *                     --out src/generated/portfolio-fund.contract.ts
 */
function parseArgs(argv: readonly string[]): { positional: string[]; flags: Record<string, string | boolean> } {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === undefined) continue;
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      flags[key] = true;
    } else {
      flags[key] = next;
      i++;
    }
  }
  return { positional, flags };
}

const USAGE = `skew-contract — generate frozen types from a contract document

  skew-contract gen --in <contract.json> --out <generated.ts> [--type-prefix <Name>] [--const-name <name>]

  gen                  Generate a TypeScript module: one frozen interface per
                       documented version, plus the document as a typed const.
  --in <path>          Contract document JSON (required)
  --out <path>         TypeScript file to write (required)
  --type-prefix <str>  Override the PascalCase prefix derived from the name
  --const-name <str>   Override the exported document const's name
  --help
`;

function main(): void {
  const { positional, flags } = parseArgs(process.argv.slice(2));

  if (flags['help'] || positional[0] === 'help') {
    process.stdout.write(USAGE);
    return;
  }

  const command = positional[0] ?? 'gen';
  if (command !== 'gen') {
    process.stderr.write(`skew-contract: unknown command "${command}"\n\n${USAGE}`);
    process.exitCode = 1;
    return;
  }

  const input = flags['in'];
  const output = flags['out'];
  if (typeof input !== 'string' || typeof output !== 'string') {
    process.stderr.write(`skew-contract gen: --in and --out are both required\n\n${USAGE}`);
    process.exitCode = 1;
    return;
  }

  const result = generateContractFile({
    in: input,
    out: output,
    typePrefix: typeof flags['type-prefix'] === 'string' ? (flags['type-prefix'] as string) : undefined,
    constName: typeof flags['const-name'] === 'string' ? (flags['const-name'] as string) : undefined,
  });

  process.stdout.write(`skew-contract: "${result.name}" → ${result.out}\n`);
}

main();
