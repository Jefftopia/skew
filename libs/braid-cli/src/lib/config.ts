import { pathToFileURL } from 'node:url';
import { access, readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import type { FragmentManifest } from '@braid/gateway';

/**
 * `braid.config.json` / `braid.config.mjs` — everything `braid dev` needs to stand up a
 * composed application locally.
 *
 * The shape deliberately mirrors production: the same manifests the gateway will serve, plus
 * the commands that produce them in development. What differs between `braid dev` and your
 * deployed gateway should be *where the endpoints point*, nothing else.
 */
export interface BraidConfig {
  /** Port the composed application is served on. Defaults to 4000. */
  port?: number;
  /** The shell application — the page fragments are composed into. */
  shell: DevTarget;
  /**
   * The fragments. Each is a gateway manifest, optionally with the dev command that serves it.
   * `endpoint` may be omitted when `dev.port` is given: it defaults to `http://localhost:<port>`.
   */
  fragments: DevFragment[];
  /** Passed through to `createGateway`. */
  gateway?: { discovery?: Record<string, unknown> };
  /**
   * Representative principals for `braid registry access`.
   *
   * The gateway holds no principal directory, so an access preview needs the operator to say who
   * to test as. Keeping them in config rather than in flags makes them reviewable and shared —
   * "the roles we care about" is a property of the deployment, not of one invocation.
   *
   * ```jsonc
   * "principals": { "trader": { "roles": ["trader"] }, "auditor": {} }
   * ```
   *
   * `anonymous` is always checked and never needs declaring.
   */
  principals?: Record<string, { roles?: string[]; scopes?: string[] }>;
}

export interface DevTarget {
  /** Where it listens once running. */
  url?: string;
  /** Started by `braid dev` when given; otherwise the target is assumed to be already running. */
  command?: string;
  /** Convenience: implies `url: http://localhost:<port>`. */
  port?: number;
  /** Working directory for `command`. Relative to the config file. */
  cwd?: string;
}

export type DevFragment = Omit<FragmentManifest, 'endpoint'> & {
  endpoint?: FragmentManifest['endpoint'];
  dev?: DevTarget;
};

export interface ResolvedTarget {
  url: string;
  command?: string;
  cwd?: string;
}

export interface ResolvedConfig {
  port: number;
  shell: ResolvedTarget;
  fragments: (FragmentManifest & { dev?: ResolvedTarget })[];
  gateway: BraidConfig['gateway'];
  principals: NonNullable<BraidConfig['principals']>;
  configPath: string;
}

const CONFIG_FILENAMES = ['braid.config.mjs', 'braid.config.js', 'braid.config.json'];

/** Finds the nearest config file, walking up from `from`. */
export async function findConfig(from: string = process.cwd()): Promise<string | null> {
  let directory = resolve(from);

  for (;;) {
    for (const filename of CONFIG_FILENAMES) {
      const candidate = resolve(directory, filename);
      if (await exists(candidate)) return candidate;
    }
    const parent = resolve(directory, '..');
    if (parent === directory) return null;
    directory = parent;
  }
}

export async function loadConfig(configPath: string): Promise<ResolvedConfig> {
  const raw = configPath.endsWith('.json')
    ? (JSON.parse(await readFile(configPath, 'utf8')) as BraidConfig)
    : ((await import(pathToFileURL(configPath).href)).default as BraidConfig);

  return resolveConfig(raw, configPath);
}

export function resolveConfig(config: BraidConfig, configPath: string): ResolvedConfig {
  const root = resolve(configPath, '..');

  const resolveTarget = (target: DevTarget, label: string): ResolvedTarget => {
    const url = target.url ?? (target.port ? `http://localhost:${target.port}` : undefined);
    if (!url) {
      throw new Error(`braid: ${label} needs a "url" or a "port" in ${configPath}`);
    }
    return {
      url,
      ...(target.command ? { command: target.command } : {}),
      ...(target.cwd ? { cwd: isAbsolute(target.cwd) ? target.cwd : resolve(root, target.cwd) } : { cwd: root }),
    };
  };

  return {
    port: config.port ?? 4000,
    principals: config.principals ?? {},
    shell: resolveTarget(config.shell, 'shell'),
    fragments: (config.fragments ?? []).map((fragment) => {
      const dev = fragment.dev ? resolveTarget(fragment.dev, `fragment "${fragment.id}"`) : undefined;
      const endpoint = fragment.endpoint ?? dev?.url;

      if (!endpoint) {
        throw new Error(
          `braid: fragment "${fragment.id}" needs an "endpoint", or a "dev" target to infer one from`,
        );
      }

      return { ...fragment, endpoint, ...(dev ? { dev } : {}) } as FragmentManifest & { dev?: ResolvedTarget };
    }),
    gateway: config.gateway,
    configPath,
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
