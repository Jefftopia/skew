import { LensOp, canonicalJson, fnv1a } from '@braidlabs/skew';

/**
 * The contract document — a schema's history as *data*.
 *
 * A closure-based migration chain can only travel inside the bundle that
 * compiled it, which is why every consumer of a contract ends up hand-copying
 * frozen interfaces and hoping they stay in agreement. A contract document is
 * the same knowledge made portable: published by the API that owns the
 * contract, fetched (or codegen'd) by consumers, interpreted — never
 * executed — on arrival.
 *
 * The property that makes runtime resolution worth having: **an API is always
 * at least as new as the newest data it serves.** A client that hits `ahead`
 * can fetch the contract from the very origin that produced the too-new data,
 * obtain the steps it was born too early to know, and migrate down. The
 * `ahead` dead end resolves itself without redeploying the client.
 *
 * Each step is either:
 *
 * - `ops` — declarative, invertible-by-construction where the ops allow, the
 *   default for structural evolution; or
 * - `code` — the name of a migration this document *cannot* express (a
 *   semantic transform). Consumers that carry an implementation under that
 *   name run it; consumers that don't degrade loudly with `gap`. A contract
 *   accumulating `code` steps is a signal the change wanted a new resource,
 *   not a new version.
 */
export interface SkewContractStep {
  readonly from: number;
  readonly to: number;
  readonly description: string;
  readonly ops?: readonly LensOp[];
  readonly code?: string;
}

export interface SkewContractDocument {
  /** Format version of the document itself. */
  readonly skewContract: '1';
  /** The contract's name — the same string consumers pass to `versioned()`. */
  readonly name: string;
  /** The newest version the publisher serves. */
  readonly current: number;
  /** Every transition, oldest first, covering v1 → `current` contiguously. */
  readonly steps: readonly SkewContractStep[];
  /** Optional JSON Schema per version, keyed by version number as a string. */
  readonly schemas?: Readonly<Record<string, unknown>>;
}

/** The well-known path a Skew-aware origin publishes contracts under. */
export function wellKnownContractPath(name: string): string {
  return `/.well-known/skew/contracts/${encodeURIComponent(name)}`;
}

/** Absolute or origin-relative URL for a contract on a given base. */
export function wellKnownContractUrl(base: string, name: string): string {
  return `${base.replace(/\/$/, '')}${wellKnownContractPath(name)}`;
}

/**
 * Content fingerprint of a document — order-insensitive for object keys, so
 * logically identical documents always agree. Used for pinning and as an
 * ETag.
 */
export function contractFingerprint(doc: SkewContractDocument): string {
  return fnv1a(canonicalJson(doc));
}

/**
 * Validates an untrusted value as a contract document. Throws `TypeError`
 * with a message naming the first problem — a malformed contract must fail at
 * the boundary where it arrived, not later inside a migration.
 */
export function parseContractDocument(raw: unknown): SkewContractDocument {
  const fail = (message: string): never => {
    throw new TypeError(`skew contract: ${message}`);
  };

  if (typeof raw !== 'object' || raw === null) fail('document must be an object');
  const doc = raw as Record<string, unknown>;

  if (doc['skewContract'] !== '1') {
    fail(`unsupported document format "${String(doc['skewContract'])}" — this reader understands "1"`);
  }
  if (typeof doc['name'] !== 'string' || doc['name'].length === 0) {
    fail('name must be a non-empty string');
  }
  const current = doc['current'];
  if (!Number.isInteger(current) || (current as number) < 1) {
    fail(`current must be a positive integer, got ${String(current)}`);
  }
  if (!Array.isArray(doc['steps'])) fail('steps must be an array');

  const steps = doc['steps'] as unknown[];
  if (steps.length !== (current as number) - 1) {
    fail(`steps must cover v1 → v${String(current)} contiguously: expected ${(current as number) - 1} steps, got ${steps.length}`);
  }

  steps.forEach((entry, index) => {
    if (typeof entry !== 'object' || entry === null) fail(`step ${index} must be an object`);
    const step = entry as Record<string, unknown>;
    const expectedTo = index + 2;
    if (step['to'] !== expectedTo) {
      fail(`step ${index} must target v${expectedTo}, got ${String(step['to'])}`);
    }
    if (step['from'] !== expectedTo - 1) {
      fail(`step ${index} must come from v${expectedTo - 1}, got ${String(step['from'])}`);
    }
    if (typeof step['description'] !== 'string' || step['description'].length === 0) {
      fail(`step ${index} needs a description`);
    }
    const hasOps = step['ops'] !== undefined;
    const hasCode = step['code'] !== undefined;
    if (hasOps === hasCode) {
      fail(`step ${index} must declare exactly one of "ops" or "code"`);
    }
    if (hasOps && !Array.isArray(step['ops'])) fail(`step ${index} ops must be an array`);
    if (hasCode && (typeof step['code'] !== 'string' || step['code'].length === 0)) {
      fail(`step ${index} code must be a non-empty migration name`);
    }
  });

  if (doc['schemas'] !== undefined && (typeof doc['schemas'] !== 'object' || doc['schemas'] === null)) {
    fail('schemas, when present, must be an object keyed by version');
  }

  return raw as SkewContractDocument;
}
