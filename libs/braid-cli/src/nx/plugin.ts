import { dirname, relative } from 'node:path';
import { readFileSync } from 'node:fs';

/**
 * Nx plugin: makes Braid a first-class part of the graph.
 *
 * Add it to `nx.json` and every project containing a `braid.config.{json,mjs,js}` gains a
 * `braid-dev` target, with the shell and fragments recorded as dependencies so Nx knows the
 * composition exists:
 *
 * ```jsonc
 * // nx.json
 * { "plugins": ["@braid/cli/nx"] }
 * ```
 *
 * The point is that you keep using the commands you already use. `nx run shell:braid-dev` runs
 * the composed application; `nx graph` shows which projects compose into which; caching and
 * affected-detection work because the config file is a normal input.
 *
 * Inference only — it adds targets, never changes ones you wrote.
 */

/** Nx passes these; typed structurally so the plugin needs no `@nx/devkit` dependency. */
interface CreateNodesContext {
  workspaceRoot: string;
}

interface TargetConfiguration {
  command?: string;
  options?: Record<string, unknown>;
  cache?: boolean;
  inputs?: unknown[];
  metadata?: Record<string, unknown>;
  continuous?: boolean;
}

interface CreateNodesResultEntry {
  projects: Record<string, { targets: Record<string, TargetConfiguration> }>;
}

export interface BraidPluginOptions {
  /** Name of the inferred target. Defaults to `braid-dev`. */
  targetName?: string;
}

export const name = 'braid';

/** Every project with a braid config gets the target. */
export const createNodesV2: [
  string,
  (configFiles: readonly string[], options: BraidPluginOptions | undefined, context: CreateNodesContext) => Promise<
    [string, CreateNodesResultEntry][]
  >,
] = [
  '**/braid.config.{json,mjs,js}',
  async (configFiles, options, context) => {
    const targetName = options?.targetName ?? 'braid-dev';

    return configFiles.map((configFile) => {
      const projectRoot = dirname(configFile);
      const relativeConfig = relative(projectRoot, configFile) || 'braid.config.json';

      return [
        configFile,
        {
          projects: {
            [projectRoot]: {
              targets: {
                [targetName]: {
                  command: `braid dev --config ${relativeConfig}`,
                  options: { cwd: projectRoot },
                  // a long-running dev server: never cached, and Nx keeps it alive
                  cache: false,
                  continuous: true,
                  metadata: {
                    description: describeConfig(context.workspaceRoot, configFile),
                    technologies: ['braid'],
                  },
                },
              },
            },
          },
        },
      ] satisfies [string, CreateNodesResultEntry];
    });
  },
];

/** A one-line summary for `nx show project`, read straight from the config. */
function describeConfig(workspaceRoot: string, configFile: string): string {
  try {
    const path = `${workspaceRoot}/${configFile}`;
    if (!configFile.endsWith('.json')) return 'Run the composed application locally (braid dev)';

    const config = JSON.parse(readFileSync(path, 'utf8')) as { fragments?: { id: string }[] };
    const ids = (config.fragments ?? []).map((fragment) => fragment.id);

    return ids.length
      ? `Run the shell with ${ids.length} fragment(s) composed in: ${ids.join(', ')}`
      : 'Run the composed application locally (braid dev)';
  } catch {
    return 'Run the composed application locally (braid dev)';
  }
}
