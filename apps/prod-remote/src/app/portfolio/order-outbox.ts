import type { OutboxEntry, OutboxService } from '@skew/angular-data';
import { API_BASE, OrderSchemaV2, type OrderV2 } from './contracts';
import { trace } from '../trace';

/**
 * The client↔API skew scenario the rest of this demo does not cover: a
 * mutation queued by one build, flushed later against a server that has
 * moved on.
 *
 * The registered runner is what actually POSTs. Two things about it matter:
 *
 * 1. **The retry-after-409 happens *inside* the runner, in one call.**
 *    `OutboxService.flush()` re-runs a failing entry with the exact same
 *    `input` on its next pass — retrying at the library level would just
 *    reproduce the same 409 forever, because nothing about the queued input
 *    would have changed. Migrating and retrying has to happen before the
 *    runner returns.
 * 2. **`entry.schemaVersion` selects which envelope gets sent first.** Both
 *    the ordinary submit path and the deliberate "queue as v1" debug button
 *    go through the same runner; the debug path just enqueues with
 *    `schemaVersion: 1`, guaranteeing a 409 the first time around so the
 *    409-then-migrate path can be demonstrated on demand.
 */
export const ORDER_MUTATION_ID = 'portfolio-order-submit';

interface DebugOrderV1 {
  fundId: string;
  action: OrderV2['action'];
  ticker?: string;
  amount: number;
  note?: string;
}

interface VersionSkewBody {
  error: 'version-skew';
  expected: number;
  received: number;
  message: string;
}

function isVersionSkewBody(body: unknown): body is VersionSkewBody {
  return (
    typeof body === 'object' &&
    body !== null &&
    (body as { error?: unknown }).error === 'version-skew'
  );
}

async function postOrder(envelope: { v: number; payload: unknown }): Promise<{
  status: number;
  ok: boolean;
  body: unknown;
}> {
  const res = await fetch(`${API_BASE}/v2/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(envelope),
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, ok: res.ok, body };
}

async function runOrderMutation(
  input: unknown,
  entry: OutboxEntry,
): Promise<unknown> {
  const firstEnvelope =
    entry.schemaVersion === 2
      ? OrderSchemaV2.write(input as OrderV2)
      : { v: entry.schemaVersion, payload: input };

  trace('step', 'order', `POST /v2/orders as v${firstEnvelope.v}`, true);
  const first = await postOrder(firstEnvelope);

  if (first.status !== 409) {
    if (!first.ok) throw new Error(`order rejected: HTTP ${first.status}`);
    trace(
      'ok',
      'order',
      `accepted directly as v${firstEnvelope.v} — no skew`,
      true,
    );
    return first.body;
  }

  if (!isVersionSkewBody(first.body)) {
    throw new Error(`order rejected: HTTP 409 (unrecognised body)`);
  }

  trace(
    'warn',
    'order',
    `409 version-skew — server wants v${first.body.expected}, queued as v${first.body.received}. Migrating and retrying.`,
    true,
  );

  // The entry's id seeds the migration's derived idempotency key: the same
  // queued order migrates to the same key on every retry, so the server can
  // deduplicate. (A clock-seeded key would mint a fresh identity per attempt.)
  const migrated = OrderSchemaV2.read(firstEnvelope, {
    context: { now: () => new Date(), seed: entry.id },
  });
  if (!migrated.ok) {
    throw new Error(
      `could not migrate queued order after version-skew: ${migrated.reason}`,
    );
  }

  const retryEnvelope = OrderSchemaV2.write(migrated.value);
  const retry = await postOrder(retryEnvelope);
  if (!retry.ok) throw new Error(`order retry rejected: HTTP ${retry.status}`);

  trace(
    'ok',
    'order',
    'accepted on retry after client-side migration to v2',
    true,
  );
  return retry.body;
}

/** Wires the order mutation into an outbox instance. Call once at construction. */
export function registerOrderMutation(outbox: OutboxService): void {
  outbox.register(ORDER_MUTATION_ID, runOrderMutation);
}

/** The ordinary path: a fully-formed v2 order, submitted as v2 from the start. */
export function enqueueOrderV2(
  outbox: OutboxService,
  order: OrderV2,
): Promise<OutboxEntry> {
  return outbox.enqueue({
    mutationId: ORDER_MUTATION_ID,
    input: order,
    schemaVersion: 2,
  });
}

/**
 * The deliberate skew demonstration: an order shaped like the *old* contract,
 * queued against an endpoint that now requires the new one. Guaranteed to hit
 * the 409-then-migrate path in `runOrderMutation` above.
 */
export function enqueueOrderV1(
  outbox: OutboxService,
  order: DebugOrderV1,
): Promise<OutboxEntry> {
  return outbox.enqueue({
    mutationId: ORDER_MUTATION_ID,
    input: order,
    schemaVersion: 1,
  });
}
