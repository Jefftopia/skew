import type { MigrationStep, VersionedSchema } from './versioned.js';
import { stepFingerprint } from './fingerprint.js';

/**
 * The shared schema registry — the federation-specific move.
 *
 * In a federated page, the parties on either side of a version boundary are
 * loaded into the *same JavaScript runtime*. A host built against v1 sits
 * beside a remote built against v2, and the remote's bundle contains exactly
 * the migration knowledge the host lacks. This registry is where that
 * knowledge is pooled: each bundle contributes the steps it knows, keyed by
 * `(contract name, target version)`, and `read()` consults it for any step
 * missing from the local chain — in **both** directions.
 *
 * The effect worth naming: an older host handed newer data no longer dead-ends
 * at `ahead`. If any loaded bundle registered a down-migration for the
 * intervening steps, the host reads an honest, lossy projection instead —
 * with `downgradedFrom` and `lossyPaths` saying exactly what happened.
 *
 * Registration is **explicit** (`registerSchema`), not automatic. Module-level
 * state shared across bundles is a capability, not a default: tests declare
 * throwaway schemas by the dozen, and a page may legitimately host unrelated
 * contracts that happen to collide on a short name. Register the contracts you
 * mean to share.
 *
 * This registry is module-level, deliberately outside any DI system. The
 * demo's rule — a remote must not depend on the host having configured
 * providers — holds here: both sides reach the same registry through the one
 * shared `@skewkit/core` instance (`sharedMappings`), with no cooperation beyond
 * that.
 *
 * ## Conflicts
 *
 * Two bundles registering the same `(name, to)` with *matching* fingerprints
 * is the healthy case — independent builds that agree. Divergent fingerprints
 * mean two builds disagree about what a version transition means: the
 * first-registered step is kept (whichever bundle loaded first — determinism
 * within a page lifetime matters more than either candidate), and a
 * diagnostic fires. That diagnostic is the only place this class of bug —
 * same name, same version, different meaning — becomes visible at all; wire
 * it to telemetry.
 */

export interface RegistryConflict {
  readonly name: string;
  readonly to: number;
  /** Fingerprint of the step that was kept (registered first). */
  readonly kept: string;
  /** Fingerprint of the step that was rejected. */
  readonly rejected: string;
  readonly keptDescription: string;
  readonly rejectedDescription: string;
}

interface RegisteredStep {
  readonly step: MigrationStep;
  readonly fingerprint: string;
}

const registry = new Map<string, Map<number, RegisteredStep>>();

let onConflict: (conflict: RegistryConflict) => void = (conflict) => {
  console.warn(
    `[skew] schema registry conflict: two builds disagree about "${conflict.name}" v${conflict.to - 1} → v${conflict.to}. ` +
      `Kept "${conflict.keptDescription}" (${conflict.kept}), rejected "${conflict.rejectedDescription}" (${conflict.rejected}). ` +
      `Same name + same version + different meaning is silent corruption everywhere except here — investigate.`,
  );
};

/**
 * Replaces the conflict diagnostic (default: `console.warn`). Pass `null` to
 * restore the default. Wire this to telemetry in production.
 */
export function setRegistryConflictHandler(handler: ((conflict: RegistryConflict) => void) | null): void {
  onConflict = handler ?? ((conflict) => {
    console.warn(
      `[skew] schema registry conflict: two builds disagree about "${conflict.name}" v${conflict.to - 1} → v${conflict.to}.`,
    );
  });
}

/** Contributes steps under a contract name. Idempotent for identical steps. */
export function registerSteps(name: string, steps: readonly (MigrationStep | undefined)[]): void {
  let byTarget = registry.get(name);
  if (!byTarget) {
    byTarget = new Map<number, RegisteredStep>();
    registry.set(name, byTarget);
  }
  for (const step of steps) {
    // Step lists built from a contract may carry holes (a named code step this
    // bundle cannot run) — a hole is nothing to share.
    if (!step) continue;
    const fingerprint = stepFingerprint(step);
    const existing = byTarget.get(step.to);
    if (!existing) {
      byTarget.set(step.to, { step, fingerprint });
      continue;
    }
    if (existing.fingerprint !== fingerprint) {
      onConflict({
        name,
        to: step.to,
        kept: existing.fingerprint,
        rejected: fingerprint,
        keptDescription: existing.step.description,
        rejectedDescription: step.description,
      });
    }
    // Matching fingerprint (or conflict): the first registration stands.
  }
}

/**
 * Contributes every step a schema knows to the shared registry, making them
 * available to any other bundle in the page reading the same contract.
 *
 * Call this once per contract, from each bundle that wants to share — the
 * newer party's registration is what lets an older party downgrade.
 */
export function registerSchema<T>(schema: VersionedSchema<T>): void {
  registerSteps(schema.name, schema.steps);
}

/** The registered step migrating `(to - 1)` → `to`, if any bundle shared one. */
export function registryStep(name: string, to: number): MigrationStep | undefined {
  return registry.get(name)?.get(to)?.step;
}

/**
 * The highest target version any registered step for `name` reaches, or
 * `null` when nothing is registered. Diagnostic use.
 */
export function registryCeiling(name: string): number | null {
  const byTarget = registry.get(name);
  if (!byTarget || byTarget.size === 0) return null;
  return Math.max(...byTarget.keys());
}

/**
 * Clears every registration. Test isolation — a shared module-level registry
 * would otherwise leak declarations between test files.
 */
export function resetSchemaRegistry(): void {
  registry.clear();
}
