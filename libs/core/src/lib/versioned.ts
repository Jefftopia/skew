import { SkewResult, err, ok } from './result.js';
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
   * Optional build identity of the writer. Not used for migration decisions —
   * it exists so a stale read can be attributed to a specific deployment when
   * debugging.
   */
  readonly b?: string;
}

/** A single step in a migration chain, from version `to - 1` to version `to`. */
export interface MigrationStep {
  readonly to: number;
  readonly description: string;
  readonly migrate: (previous: any) => any;
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

/**
 * A versioned schema: the single place a type's current version, its history,
 * and the functions that move data between them are declared.
 *
 * ```ts
 * export const WeeklyContent = versioned<V1>('weekly-content')
 *   .next<V2>('rename themeQuote to scriptureOfWeek', (p) => ({
 *     ...p, scriptureOfWeek: p.themeQuote,
 *   }))
 *   .next<V3>('introduce orderOfWorship', (p) => ({
 *     ...p, orderOfWorship: { setting: '', hymns: [] },
 *   }));
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
 */
export interface VersionedSchema<TCurrent> {
  readonly name: string;
  /** Current version — 1 plus the number of `next()` steps declared. */
  readonly version: number;
  /** Declared history, oldest first. Useful for tooling and diagnostics. */
  readonly steps: readonly MigrationStep[];

  /**
   * Reads possibly-stale data, migrating it forward to the current version.
   *
   * Accepts an envelope, or bare legacy data written before envelopes were
   * adopted (see {@link VersionedOptions.assumeLegacyVersion}).
   */
  read(raw: unknown): SkewResult<TCurrent>;

  /** Wraps a current-version value for storage or transport. */
  write(value: TCurrent, buildId?: string): VersionedEnvelope<TCurrent>;

  /**
   * Extends the schema with the next version.
   *
   * The returned schema is fully usable — there is no terminal `build()` call,
   * so the chain reads as a single declaration.
   */
  next<TNext>(migrate: (previous: TCurrent) => TNext): VersionedSchema<TNext>;
  next<TNext>(
    description: string,
    migrate: (previous: TCurrent) => TNext,
  ): VersionedSchema<TNext>;
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

function build<TCurrent>(
  name: string,
  steps: readonly MigrationStep[],
  options: VersionedOptions<any>,
): VersionedSchema<TCurrent> {
  const version = steps.length + 1;
  const legacyVersion = options.assumeLegacyVersion ?? 1;

  const schema: VersionedSchema<TCurrent> = {
    name,
    version,
    steps,

    write(value: TCurrent, buildId?: string): VersionedEnvelope<TCurrent> {
      return buildId === undefined
        ? { v: version, payload: value }
        : { v: version, payload: value, b: buildId };
    },

    read(raw: unknown): SkewResult<TCurrent> {
      // Not public API — see `disabled.ts`. Reproduces `raw as TCurrent`: no
      // envelope check, no version comparison, no migration. Data from a newer
      // build is handed back as though it were current, which is precisely the
      // failure this function exists to prevent.
      if (isSkewDisabled()) return ok(raw as TCurrent);

      if (raw === null || raw === undefined) {
        return err('invalid', 0, version, `[${name}] no data to read`);
      }

      const enveloped = isEnvelope(raw);
      const found = enveloped ? raw.v : legacyVersion;
      let data: unknown = enveloped ? raw.payload : raw;

      if (!Number.isInteger(found) || found < 1) {
        return err('invalid', found, version, `[${name}] envelope carries a non-version: ${found}`);
      }

      // Data from the future. There is no honest way to migrate downward —
      // fields added by the newer build simply are not present here to remove.
      if (found > version) {
        return err(
          'ahead',
          found,
          version,
          `[${name}] data was written by a newer build (v${found}) than this one (v${version}). ` +
            `Refetch, or update the client — migrating downward would discard data.`,
        );
      }

      if (found < version) {
        for (let target = found + 1; target <= version; target++) {
          const step = steps[target - 2]; // steps[0] migrates to v2
          if (!step) {
            return err(
              'gap',
              found,
              version,
              `[${name}] no migration declared for v${target - 1} → v${target}`,
            );
          }
          try {
            data = step.migrate(data);
          } catch (cause) {
            return err(
              'threw',
              found,
              version,
              `[${name}] migration to v${target} ("${step.description}") failed`,
              cause,
            );
          }
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

      return ok(data as TCurrent, found === version ? null : found);
    },

    next<TNext>(
      descriptionOrMigrate: string | ((previous: TCurrent) => TNext),
      maybeMigrate?: (previous: TCurrent) => TNext,
    ): VersionedSchema<TNext> {
      const hasDescription = typeof descriptionOrMigrate === 'string';
      const migrate = (hasDescription ? maybeMigrate : descriptionOrMigrate) as (
        previous: TCurrent,
      ) => TNext;

      if (typeof migrate !== 'function') {
        throw new TypeError(`[${name}] next() requires a migration function`);
      }

      const step: MigrationStep = {
        to: version + 1,
        description: hasDescription ? descriptionOrMigrate : `v${version} → v${version + 1}`,
        migrate,
      };

      return build<TNext>(name, [...steps, step], options);
    },
  };

  return schema;
}
