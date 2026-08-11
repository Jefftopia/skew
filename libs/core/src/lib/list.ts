import { MigrationStep, VersionedOptions, VersionedSchema, versioned } from './versioned.js';

/**
 * A list schema derived from an item schema, so the two cannot drift apart.
 *
 * The failure this prevents is quiet: a `Fund` schema and a `Fund[]` schema
 * maintained side by side share their migration logic by discipline only, and
 * the day someone edits one chain without the other, records migrate
 * differently depending on whether they arrived alone or in a collection.
 * Deriving the list from the item makes that impossible — every step here
 * *is* the item's step, mapped.
 *
 * Provenance paths are re-rooted with an `[]` prefix (`liquidity.hqlaPct`
 * becomes `[].liquidity.hqlaPct`), so a consumer of the list result can still
 * tell exactly which fields of which shape were guessed or discarded.
 */
export function versionedList<TItem>(
  itemSchema: VersionedSchema<TItem>,
  nameOrOptions?: string | (VersionedOptions<TItem[]> & { readonly name?: string }),
): VersionedSchema<TItem[]> {
  const opts = typeof nameOrOptions === 'string' ? { name: nameOrOptions } : (nameOrOptions ?? {});
  const name = opts.name ?? `${itemSchema.name}[]`;

  let schema = versioned<unknown>(name, {
    assumeLegacyVersion: opts.assumeLegacyVersion,
    validate: opts.validate
      ? (opts.validate as (value: unknown) => value is unknown)
      : undefined,
  });

  for (const step of itemSchema.steps) {
    schema = schema.next<unknown>(step.description, liftStep(step));
  }

  return schema as VersionedSchema<TItem[]>;
}

function liftStep(step: MigrationStep): {
  up: (list: unknown, ctx: Parameters<MigrationStep['up']>[1]) => unknown;
  down?: (list: unknown, ctx: Parameters<MigrationStep['up']>[1]) => unknown;
  derives?: readonly string[];
  downDerives?: readonly string[];
  lossy?: readonly string[];
} {
  const requireArray = (list: unknown): readonly unknown[] => {
    if (!Array.isArray(list)) {
      throw new Error(`expected an array, got ${list === null ? 'null' : typeof list}`);
    }
    return list;
  };

  const prefix = (paths: readonly string[] | undefined) => paths?.map((p) => `[].${p}`);

  return {
    up: (list, ctx) => requireArray(list).map((item) => step.up(item, ctx)),
    down: step.down
      ? (list, ctx) => requireArray(list).map((item) => (step.down as NonNullable<MigrationStep['down']>)(item, ctx))
      : undefined,
    derives: prefix(step.derives),
    downDerives: prefix(step.downDerives),
    lossy: prefix(step.lossy),
  };
}
