import {
  MigrationContext,
  MigrationStep,
  VersionedSchema,
  compileLens,
  registerSteps,
  versionedFromSteps,
} from '@skewkit/core';
import { SkewContractDocument, SkewContractStep } from './document.js';

/**
 * A named implementation for a contract step declared as `code` — the escape
 * hatch for semantic migrations the op set cannot express. Shipped inside the
 * consuming bundle, referenced by name from the document.
 */
export interface ContractCodeStep<TFrom = unknown, TTo = unknown> {
  readonly up: (previous: TFrom, ctx: MigrationContext) => TTo;
  readonly down?: (next: TTo, ctx: MigrationContext) => TFrom;
  readonly derives?: readonly string[];
  readonly downDerives?: readonly string[];
  readonly lossy?: readonly string[];
}

export interface ContractSchemaOptions<TCurrent> {
  /**
   * Version this build is pinned to. Defaults to the document's `current`.
   * A build pinned below `current` still learns the newer steps: they are
   * contributed to the shared registry (unless `register` is false), which is
   * what lets `read()` downgrade data from the future.
   */
  readonly at?: number;
  /** Implementations for the document's named `code` steps. */
  readonly codeSteps?: Readonly<Record<string, ContractCodeStep<any, any>>>;
  /**
   * Contribute every runnable step to the shared registry. Defaults to
   * `true` — adopting a published contract *is* the explicit act of sharing
   * that plain `versioned()` declarations require `registerSchema` for.
   */
  readonly register?: boolean;
  readonly validate?: (value: unknown) => value is TCurrent;
  readonly assumeLegacyVersion?: number;
}

/**
 * Builds a {@link VersionedSchema} from a contract document — the drop-in,
 * data-driven replacement for a hand-maintained `versioned().next()` chain.
 *
 * - `ops` steps compile to up *and* (where invertible) down migrations, with
 *   derived and lossy paths computed rather than hand-annotated.
 * - `code` steps use the implementation supplied in `codeSteps`; a missing
 *   implementation leaves a hole that reads as `gap` — loud, not guessed.
 * - Steps beyond the pinned version feed the shared registry, so this build
 *   can downgrade newer data it could never have shipped knowledge of.
 */
export function versionedFromContract<TCurrent>(
  doc: SkewContractDocument,
  options: ContractSchemaOptions<TCurrent> = {},
): VersionedSchema<TCurrent> {
  const at = options.at ?? doc.current;
  if (!Number.isInteger(at) || at < 1 || at > doc.current) {
    throw new TypeError(
      `skew contract: cannot pin "${doc.name}" at v${at} — the document covers v1 through v${doc.current}`,
    );
  }

  const localSteps: (MigrationStep | undefined)[] = [];
  const futureSteps: MigrationStep[] = [];

  for (const contractStep of doc.steps) {
    const step = materialize(doc.name, contractStep, options.codeSteps);
    if (contractStep.to <= at) {
      localSteps[contractStep.to - 2] = step;
    } else if (step) {
      futureSteps.push(step);
    }
  }
  // Preserve chain length even when the last local step is a hole.
  localSteps.length = at - 1;

  const schema = versionedFromSteps<TCurrent>(doc.name, localSteps, {
    validate: options.validate,
    assumeLegacyVersion: options.assumeLegacyVersion,
  });

  if (options.register !== false) {
    registerSteps(doc.name, localSteps);
    registerSteps(doc.name, futureSteps);
  }

  return schema;
}

/** Compiles one contract step, or returns `undefined` for an unrunnable one. */
function materialize(
  name: string,
  contractStep: SkewContractStep,
  codeSteps: Readonly<Record<string, ContractCodeStep<any, any>>> | undefined,
): MigrationStep | undefined {
  if (contractStep.ops) {
    const lens = compileLens(contractStep.ops);
    return {
      to: contractStep.to,
      description: contractStep.description,
      up: lens.up,
      down: lens.down ?? undefined,
      derives: lens.derivedUp,
      downDerives: lens.derivedDown,
      lossy: lens.lossyDown,
      ops: contractStep.ops,
    };
  }

  const implementation = contractStep.code ? codeSteps?.[contractStep.code] : undefined;
  if (!implementation) return undefined;

  return {
    to: contractStep.to,
    description: contractStep.description,
    up: implementation.up,
    down: implementation.down,
    derives: implementation.derives,
    downDerives: implementation.downDerives,
    lossy: implementation.lossy,
  };
}
