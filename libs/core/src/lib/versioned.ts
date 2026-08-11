import { SkewResult, err, ok } from './result.js';
import { MigrationContext, defaultMigrationContext } from './context.js';
import { LensOp, compileLens } from './lens.js';
import { chainFingerprint } from './fingerprint.js';
import { registryStep } from './registry.js';
import { isSkewDisabled } from './disabled.js';

/**
 * Anything that crosses a version boundary is wrapped with the version it was
 * *authored* under.
 *
 * The version sits outside the payload deliberately: a reader can determine the
 * shape without parsing, validating, or trusting the payload.
 */
export interface VersionedEnvelope<T = unknown> {
  /** Schema version the payload was written under. */
  readonly v: number;
  readonly payload: T;
  /**
   * Contract name the payload belongs to. Optional on the wire — hand-written
   * envelopes and older builds omit it — but written by every `write()`, and
   * checked on read: an envelope naming a *different* contract is refused as
   * `invalid` instead of being silently misread through the wrong chain.
   */
  readonly n?: string;
  /**
   * Optional build identity of the writer. Not used for migration decisions —
   * it exists so a stale read can be attributed to a specific deployment when
   * debugging.
   */
  readonly b?: string;
}

/**
 * A single step in a migration chain, from version `to - 1` to version `to`.
 *
 * `up` is mandatory — it is what "declaring the next version" means. `down`
 * is the optional inverse: a projection back onto the older shape, honest but
 * usually lossy. Steps authored as ops (see {@link LensOp}) get `down`,
 * `derives`, and `lossy` computed; steps authored as code declare them.
 */
export interface MigrationStep<TFrom = unknown, TTo = unknown> {
  readonly to: number;
  readonly description: string;
  readonly up: (previous: TFrom, ctx: MigrationContext) => TTo;
  readonly down?: (next: TTo, ctx: MigrationContext) => TFrom;
  /** Paths `up` fills with guesses rather than writer-reported data. */
  readonly derives?: readonly string[];
  /** Paths `down` fills with guesses (e.g. a restored default). */
  readonly downDerives?: readonly string[];
  /** Paths `down` discards — the price of projecting onto the older shape. */
  readonly lossy?: readonly string[];
  /** The declarative ops this step was authored from, when it was. */
  readonly ops?: readonly LensOp[];
}

/** A code-authored step: an up migration, optionally its down inverse. */
export interface CodeStepSpec<TFrom, TTo> {
  readonly up: (previous: TFrom, ctx: MigrationContext) => TTo;
  readonly down?: (next: TTo, ctx: MigrationContext) => TFrom;
  readonly derives?: readonly string[];
  readonly downDerives?: readonly string[];
  readonly lossy?: readonly string[];
}

/** An ops-authored step: everything else is computed from the ops. */
export interface OpsStepSpec {
  readonly ops: readonly LensOp[];
}

export interface VersionedOptions<T> {
  /**
   * Shape check applied *after* migration completes. Bring your own validator
   * (zod, valibot, a hand-written guard) — core stays dependency-free.
   */
  readonly validate?: (value: unknown) => value is T;
  /**
   * Version to assume for data that carries no envelope, i.e. records written
   * before this schema was adopted. Defaults to 1, which makes adoption
   * seamless: declare your *existing* shape as v1 and legacy rows migrate
   * forward from there without a backfill.
   */
  readonly assumeLegacyVersion?: number;
}

/** Per-call options for {@link VersionedSchema.read}. */
export interface ReadOptions {
  /**
   * Version of bare (un-enveloped) data, when the caller learned it out of
   * band — a URL (`/v2/funds`), a header, a media type. Most HTTP APIs carry
   * the version there rather than in the body; this is how you tell `read`
   * to trust that instead of `assumeLegacyVersion`. Ignored when the data
   * carries an envelope — the envelope is the writer's own statement.
   */
  readonly assumeVersion?: number;
  /** Clock and seed for the migrations this read runs. Pin it in tests. */
  readonly context?: MigrationContext;
}

/** Options object form for {@link VersionedSchema.write}. */
export interface WriteOptions {
  /** Stamped onto the envelope for attribution. */
  readonly buildId?: string;
  /**
   * Target version to write at, when addressing a reader known to be older —
   * writer-makes-right. Requires every intervening step to declare `down`;
   * throws otherwise, because a writer's own chain is statically known and
   * asking for an unreachable version is a programming error, not data skew.
   */
  readonly as?: number;
  /** Clock and seed for any down-migrations this write runs. */
  readonly context?: MigrationContext;
}

/**
 * A versioned schema: the single place a type's current version, its history,
 * and the functions that move data between them are declared.
 *
 * ```ts
 * export const WeeklyContent = versioned<V1>('weekly-content')
 *   .next<V2>('rename themeQuote to scriptureOfWeek', (p) => ({
 *     id: p.id,
 *     scriptureOfWeek: p.themeQuote,
 *   }))
 *   .next<V3>('introduce orderOfWorship', {
 *     up: (p) => ({ ...p, orderOfWorship: { setting: '', hymns: [] } }),
 *     down: ({ orderOfWorship, ...rest }) => rest,
 *     derives: ['orderOfWorship'],
 *     lossy: ['orderOfWorship'],
 *   });
 *
 * const result = WeeklyContent.read(rawFromStorage);
 * if (result.ok) render(result.value);
 * ```
 *
 * ## The one rule
 *
 * A migration must never import your current application types or services.
 * Close each step over its own snapshot types (`V1`, `V2`, …). The moment a
 * migration references a live interface, it silently changes meaning the next
 * time that interface is edited — and your old migrations start lying.
 *
 * ## The second rule
 *
 * Migrations are deterministic. Take the clock (and any uniqueness seed) from
 * the {@link MigrationContext} argument, never from `new Date()` or
 * `Math.random()` — a migration whose output varies between runs breaks
 * replays, retries, and tests in ways that surface far from the cause.
 */
export interface VersionedSchema<TCurrent> {
  readonly name: string;
  /** Current version — 1 plus the number of `next()` steps declared. */
  readonly version: number;
  /** Declared history, oldest first. Useful for tooling and diagnostics. */
  readonly steps: readonly MigrationStep[];
  /**
   * Content fingerprint of the whole chain (name, version, per-step
   * identity). Two builds whose fingerprints match agree about what this
   * contract means; the registry uses this to detect builds that do not.
   */
  readonly fingerprint: string;

  /**
   * Reads possibly-stale data and migrates it to the current version — in
   * either direction.
   *
   * Older data migrates **up** through the chain (`migratedFrom` set, guessed
   * fields listed in `derivedPaths`). Newer data migrates **down** when every
   * intervening step — from this chain or contributed to the shared registry
   * by a newer bundle or a resolved contract — declares a `down`
   * (`downgradedFrom` set, discarded fields listed in `lossyPaths`).
   * Otherwise the read refuses with `ahead`, exactly as before.
   *
   * Accepts an envelope, or bare legacy data (see
   * {@link VersionedOptions.assumeLegacyVersion} and
   * {@link ReadOptions.assumeVersion}).
   */
  read(raw: unknown, options?: ReadOptions): SkewResult<TCurrent>;

  /**
   * Wraps a value for storage or transport.
   *
   * With no options, writes the current version. With `{ as }`, down-migrates
   * first and writes the older envelope — the polite move when the reader is
   * known to be older than this build.
   */
  write(value: TCurrent, buildId?: string): VersionedEnvelope<TCurrent>;
  write(value: TCurrent, options: WriteOptions): VersionedEnvelope;

  /**
   * Extends the schema with the next version. The description is required —
   * it is the human-owned identity of the step, and the only part of a code
   * step that two independent builds can be compared by.
   *
   * The returned schema is fully usable — there is no terminal `build()` call,
   * so the chain reads as a single declaration.
   */
  next<TNext>(
    description: string,
    migrate: (previous: TCurrent, ctx: MigrationContext) => TNext,
  ): VersionedSchema<TNext>;
  next<TNext>(description: string, spec: CodeStepSpec<TCurrent, TNext>): VersionedSchema<TNext>;
  next<TNext>(description: string, spec: OpsStepSpec): VersionedSchema<TNext>;
}

/** True when `value` looks like a {@link VersionedEnvelope}. */
export function isEnvelope(value: unknown): value is VersionedEnvelope {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { v?: unknown }).v === 'number' &&
    'payload' in value
  );
}

/**
 * Reads the version off raw data without migrating it.
 * Returns `null` for data that carries no envelope.
 */
export function peekVersion(raw: unknown): number | null {
  return isEnvelope(raw) ? raw.v : null;
}

/**
 * Begins a versioned schema declaration.
 *
 * @param name Stable identifier, used in diagnostics and by storage keys.
 * @typeParam TBase The shape at version 1 — for an existing codebase, this is
 *                  your *current* shape, so adoption requires no backfill.
 */
export function versioned<TBase>(
  name: string,
  options: VersionedOptions<any> = {},
): VersionedSchema<TBase> {
  return build<TBase>(name, [], options);
}

/**
 * Constructs a schema from an explicit step list — the loader's entry point,
 * used by tooling that assembles steps from a contract document rather than
 * declaring them fluently.
 *
 * The list is indexed by target version (`steps[0]` migrates to v2) and MAY
 * contain holes: a hole is a transition this build knows *of* but cannot
 * *run* — a contract's named code step whose implementation this bundle does
 * not carry. Reads that need a missing step fail with `gap` (or fall back to
 * a registry contribution), which is the loud degradation the contract format
 * promises. Application code should prefer {@link versioned}.
 */
export function versionedFromSteps<TCurrent>(
  name: string,
  steps: readonly (MigrationStep | undefined)[],
  options: VersionedOptions<any> = {},
): VersionedSchema<TCurrent> {
  return build<TCurrent>(name, steps as readonly MigrationStep[], options);
}

function build<TCurrent>(
  name: string,
  steps: readonly MigrationStep[],
  options: VersionedOptions<any>,
): VersionedSchema<TCurrent> {
  const version = steps.length + 1;
  const legacyVersion = options.assumeLegacyVersion ?? 1;
  let fingerprint: string | null = null;

  /** Local chain first; the shared registry covers what this build lacks. */
  const stepFor = (to: number): MigrationStep | undefined =>
    steps[to - 2] ?? registryStep(name, to);

  const schema: VersionedSchema<TCurrent> = {
    name,
    version,
    steps,

    get fingerprint(): string {
      return (fingerprint ??= chainFingerprint(name, version, steps));
    },

    write(value: TCurrent, buildIdOrOptions?: string | WriteOptions): VersionedEnvelope<TCurrent> {
      const opts: WriteOptions =
        typeof buildIdOrOptions === 'string' || buildIdOrOptions === undefined
          ? { buildId: buildIdOrOptions }
          : buildIdOrOptions;
      const target = opts.as ?? version;
      const ctx = opts.context ?? defaultMigrationContext;

      if (!Number.isInteger(target) || target < 1 || target > version) {
        throw new TypeError(
          `[${name}] cannot write at v${target}: this build knows v1 through v${version}`,
        );
      }

      let payload: unknown = value;
      for (let from = version; from > target; from--) {
        const step = steps[from - 2];
        if (!step?.down) {
          throw new TypeError(
            `[${name}] cannot write at v${target}: step v${from - 1} → v${from}` +
              (step ? ` ("${step.description}") declares no down-migration` : ' is missing'),
          );
        }
        payload = step.down(payload, ctx);
      }

      const envelope: { v: number; n: string; payload: unknown; b?: string } = {
        v: target,
        n: name,
        payload,
      };
      if (opts.buildId !== undefined) envelope.b = opts.buildId;
      return envelope as VersionedEnvelope<TCurrent>;
    },

    read(raw: unknown, readOptions: ReadOptions = {}): SkewResult<TCurrent> {
      // Not public API — see `disabled.ts`. Reproduces `raw as TCurrent`: no
      // envelope check, no version comparison, no migration. Data from a newer
      // build is handed back as though it were current, which is precisely the
      // failure this function exists to prevent.
      if (isSkewDisabled()) return ok(raw as TCurrent);

      if (raw === null || raw === undefined) {
        return err('invalid', 0, version, `[${name}] no data to read`);
      }

      const ctx = readOptions.context ?? defaultMigrationContext;
      const enveloped = isEnvelope(raw);
      const found = enveloped ? raw.v : (readOptions.assumeVersion ?? legacyVersion);
      let data: unknown = enveloped ? raw.payload : raw;

      if (enveloped && typeof raw.n === 'string' && raw.n !== name) {
        return err(
          'invalid',
          found,
          version,
          `[${name}] envelope belongs to contract "${raw.n}", not "${name}" — ` +
            `reading it through this schema would migrate the wrong data`,
        );
      }

      if (!Number.isInteger(found) || found < 1) {
        return err('invalid', found, version, `[${name}] envelope carries a non-version: ${found}`);
      }

      const derivedPaths: string[] = [];
      const lossyPaths: string[] = [];

      if (found > version) {
        // Data from the future. It can still be read *if* every intervening
        // step is known — locally or via the shared registry — and declares a
        // down-migration; the result is an honest, lossy projection. When any
        // step is missing or one-way, refuse exactly as before: guessing
        // would discard data silently.
        const descending: MigrationStep[] = [];
        for (let to = version + 1; to <= found; to++) {
          const step = stepFor(to);
          if (!step?.down) {
            return err(
              'ahead',
              found,
              version,
              `[${name}] data was written by a newer build (v${found}) than this one (v${version})` +
                (step
                  ? `, and step v${to - 1} → v${to} ("${step.description}") declares no down-migration. `
                  : `, and no loaded bundle or resolved contract knows the v${to - 1} → v${to} step. `) +
                `Refetch, resolve the contract, or update the client — guessing would discard data.`,
            );
          }
          descending.push(step);
        }
        for (let i = descending.length - 1; i >= 0; i--) {
          const step = descending[i] as MigrationStep & { down: NonNullable<MigrationStep['down']> };
          try {
            data = step.down(data, ctx);
          } catch (cause) {
            return err(
              'threw',
              found,
              version,
              `[${name}] down-migration from v${step.to} ("${step.description}") failed`,
              cause,
            );
          }
          if (step.lossy) lossyPaths.push(...step.lossy);
          if (step.downDerives) derivedPaths.push(...step.downDerives);
        }
      }

      if (found < version) {
        for (let target = found + 1; target <= version; target++) {
          const step = stepFor(target);
          if (!step) {
            return err(
              'gap',
              found,
              version,
              `[${name}] no migration declared for v${target - 1} → v${target}`,
            );
          }
          try {
            data = step.up(data, ctx);
          } catch (cause) {
            return err(
              'threw',
              found,
              version,
              `[${name}] migration to v${target} ("${step.description}") failed`,
              cause,
            );
          }
          if (step.derives) derivedPaths.push(...step.derives);
        }
      }

      if (options.validate && !options.validate(data)) {
        return err(
          'invalid',
          found,
          version,
          `[${name}] value failed validation after migrating v${found} → v${version}`,
        );
      }

      return ok(data as TCurrent, {
        migratedFrom: found < version ? found : null,
        downgradedFrom: found > version ? found : null,
        derivedPaths,
        lossyPaths,
      });
    },

    next<TNext>(
      description: string,
      migrateOrSpec:
        | ((previous: TCurrent, ctx: MigrationContext) => TNext)
        | CodeStepSpec<TCurrent, TNext>
        | OpsStepSpec,
    ): VersionedSchema<TNext> {
      if (typeof description !== 'string' || description.length === 0) {
        throw new TypeError(
          `[${name}] next() requires a description — it is the step's identity, ` +
            `and the only thing two independent builds can compare a code step by`,
        );
      }

      let step: MigrationStep;

      if (typeof migrateOrSpec === 'function') {
        step = { to: version + 1, description, up: migrateOrSpec as MigrationStep['up'] };
      } else if (migrateOrSpec !== null && typeof migrateOrSpec === 'object' && 'ops' in migrateOrSpec) {
        const lens = compileLens(migrateOrSpec.ops);
        step = {
          to: version + 1,
          description,
          up: lens.up,
          down: lens.down ?? undefined,
          derives: lens.derivedUp,
          downDerives: lens.derivedDown,
          lossy: lens.lossyDown,
          ops: migrateOrSpec.ops,
        };
      } else if (migrateOrSpec !== null && typeof migrateOrSpec === 'object' && typeof migrateOrSpec.up === 'function') {
        const spec = migrateOrSpec;
        step = {
          to: version + 1,
          description,
          up: spec.up as MigrationStep['up'],
          down: spec.down as MigrationStep['down'],
          derives: spec.derives,
          downDerives: spec.downDerives,
          lossy: spec.lossy,
        };
      } else {
        throw new TypeError(`[${name}] next() requires a migration function, a { up, down? } spec, or { ops }`);
      }

      return build<TNext>(name, [...steps, step], options);
    },
  };

  return schema;
}
