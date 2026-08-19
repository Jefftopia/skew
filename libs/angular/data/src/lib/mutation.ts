import { Signal, computed, inject, signal } from '@angular/core';
import { CacheRegistry } from './cache-registry';
import { OutboxService } from './outbox';
import { EntityStore, type StoreTransaction } from './store';
import { PendingWrites, recordOverlays, toOutboxOverlay, type EntityOverlay } from './overlay';
import type { EntityType } from './entity';

/**
 * A write, with the three things every application ends up reimplementing:
 * optimistic application, rollback on failure, and durability.
 *
 * All three are one mechanism here: the **queue**. A write is queued before it
 * is sent, every reader derives `confirmed ⊕ pending` from that queue, and
 * settling it — confirmed or abandoned — is deleting the entry. There is no undo
 * log, because there is nothing to undo: nothing was written to the confirmed
 * graph in the first place.
 *
 * That is a change from the obvious design, and the reason is what the obvious
 * design cannot do. An optimistic patch applied to the store with an undo log in
 * memory is invisible to the other apps on the page and does not survive a
 * reload — so a user who queues a change offline and refreshes sees the *old*
 * value while their edit sits in storage waiting to send.
 */

export type MutationStatus = 'idle' | 'pending' | 'success' | 'error';

/**
 * The server accepted the write and stored something else.
 *
 * Not a failure — servers normalize, resolve, and apply rules the client does
 * not know about — which is exactly why it is so easy to ship a UI that swaps
 * the value under whoever just typed it.
 */
export interface MutationConflict {
  /** The record as the screen showed it: confirmed, with this write's prediction applied. */
  expected: unknown;
  /** The record the server reported. */
  actual: unknown;
  /** The predicted fields the server disagreed about. */
  paths: readonly string[];
  /** Which record this is about. */
  entity: { typeName: string; id: string };
}

/**
 * What to do when the server disagrees.
 *
 * `'raise'` by default. The stored record becomes the server's value either way — you cannot make a
 * server hold your value without another mutation — so the only question is whether the user is
 * told, and the silent answer is a support ticket about someone's money.
 */
export type ConflictPolicy = 'raise' | 'accept' | ((conflict: MutationConflict) => unknown);

export interface MutationConfig<TInput, TResult> {
  /**
   * Stable identifier. Required when `durability: 'outbox'`, because a queued
   * entry outlives the closure and must find its operation again by name after
   * a reload.
   */
  readonly id?: string;
  readonly operation: (input: TInput) => Promise<TResult>;
  /**
   * Describes the change locally before the server has agreed.
   *
   * Still a callback taking a transaction, and still written exactly as it was —
   * but the transaction now **records** rather than writes. `tx.patch(Bulletin,
   * id, { status: 'published' })` was always a description; recording it is what
   * lets the same description survive a reload, which a closure never could.
   */
  readonly optimistic?: (tx: StoreTransaction, input: TInput) => void;
  /**
   * Normalizes the server's response back into the store — the confirmed half.
   *
   * Receives the value chosen by `onConflict` when a resolver returned one, so a
   * team that reconciles a disagreement writes the reconciled record rather than
   * having to re-apply it afterwards.
   */
  readonly onSuccess?: (store: EntityStore, result: TResult, input: TInput) => void;
  /** Tags to mark stale once the write lands. */
  readonly invalidates?: (input: TInput, result?: TResult) => readonly string[];
  /**
   * `'outbox'` persists the mutation so it survives a reload and replays when
   * connectivity returns. `'memory'` (default) fails fast.
   *
   * The overlay is derived from the queue either way. The difference is what
   * rebuilds it: a persisted entry can be read back after a reload, and an
   * in-memory one correctly dies with the page that made it.
   */
  readonly durability?: 'memory' | 'outbox';
  /** Payload contract version, carried on queued entries. */
  readonly schemaVersion?: number;
  /** Defaults to `'raise'`. */
  readonly onConflict?: ConflictPolicy;
}

export interface MutationRef<TInput, TResult> {
  mutate(input: TInput): Promise<TResult>;
  readonly status: Signal<MutationStatus>;
  readonly error: Signal<unknown>;
  readonly isPending: Signal<boolean>;
  /** True while this mutation's prediction is on screen and unconfirmed. */
  readonly hasPendingWrite: Signal<boolean>;
  /** The last disagreement, under the `'raise'` policy. Cleared by the next attempt. */
  readonly conflict: Signal<MutationConflict | null>;
  /** Dismisses a raised conflict, once the user has seen it. */
  acknowledgeConflict(): void;
}

/**
 * Creates a mutation. Must be called in an injection context.
 *
 * ```ts
 * readonly publish = mutation({
 *   id: 'bulletin.publish',
 *   operation: (b: Bulletin) => firstValueFrom(this.http.post(`/api/bulletins/${b.id}/publish`, b)),
 *   optimistic: (tx, b) => tx.patch(Bulletin, b.id, { status: 'published' }),
 *   invalidates: (b) => [tag.entity(Bulletin, b.id), 'bulletins'],
 *   durability: 'outbox',
 *   schemaVersion: 41,
 * });
 * ```
 */
export function mutation<TInput, TResult>(
  config: MutationConfig<TInput, TResult>,
): MutationRef<TInput, TResult> {
  const store = inject(EntityStore);
  const registry = inject(CacheRegistry);
  const outbox = inject(OutboxService);
  const pending = inject(PendingWrites);

  const durability = config.durability ?? 'memory';
  if (durability === 'outbox' && !config.id) {
    throw new TypeError(
      '[skew/data] a mutation with durability: "outbox" requires a stable `id`. ' +
        'Queued entries outlive the closure and are matched back to their operation by id.',
    );
  }

  const status = signal<MutationStatus>('idle');
  const error = signal<unknown>(undefined);
  const conflict = signal<MutationConflict | null>(null);
  const applied = signal(0);

  // Replay path. Registered eagerly so a queue rehydrated at start-up has
  // somewhere to go — this is why outbox mutations must be created during
  // bootstrap rather than lazily inside a handler.
  if (durability === 'outbox' && config.id) {
    outbox.register(config.id, async (input) => config.operation(input as TInput));
  }

  async function mutate(input: TInput): Promise<TResult> {
    status.set('pending');
    error.set(undefined);
    conflict.set(null);

    const recorded = config.optimistic
      ? recordOverlays((tx) => config.optimistic?.(tx, input))
      : { overlays: [] as EntityOverlay[], types: new Map<string, EntityType<unknown>>() };

    // Applied synchronously and only here: the confirmed graph is never touched by a prediction.
    let groupId = `local:${crypto.randomUUID()}`;
    pending.add(groupId, recorded.overlays, { durable: durability === 'outbox' });
    if (recorded.overlays.length > 0) applied.update((n) => n + 1);

    // What the screen showed, captured before the server answers, so a conflict is measured against
    // the prediction rather than against whatever the record has become since.
    const expected = new Map<string, unknown>();
    for (const overlay of recorded.overlays) {
      const type = recorded.types.get(overlay.typeName);
      if (type) expected.set(overlayId(overlay), store.peek(type, overlay.id));
    }

    // Queued *before* sending, not on failure. The entry is what readers overlay, so a write only
    // recorded once it fails is a write nobody can see while it is in flight — and one that a crash
    // mid-request loses entirely.
    let entryId: string | null = null;
    if (durability === 'outbox' && config.id) {
      const entry = await outbox.enqueue({
        mutationId: config.id,
        input,
        schemaVersion: config.schemaVersion ?? 1,
        optimistic: recorded.overlays.map(toOutboxOverlay),
      });
      entryId = entry.id;
      // Re-keyed so the queue's own copy of this group replaces it rather than doubling it.
      pending.rename(groupId, entry.id);
      groupId = entry.id;
    }

    try {
      const result = await config.operation(input);

      const found = detectConflict(recorded, expected, result, store);
      let confirmed: TResult = result;
      if (found) {
        const policy = config.onConflict ?? 'raise';
        if (typeof policy === 'function') confirmed = policy(found) as TResult;
        else if (policy === 'raise') conflict.set(found);
      }

      config.onSuccess?.(store, confirmed, input);

      // The overlay lifts only after the confirmed value is in the store, so the value on screen
      // never drops back to the old one for a frame between the two.
      await settle(entryId, groupId);

      const tags = config.invalidates?.(input, result);
      if (tags?.length) registry.invalidate(...tags);

      status.set('success');
      return result;
    } catch (caught) {
      if (entryId) {
        // Keep the prediction and keep the entry: from the user's point of view the change happened,
        // and the queue is what will make that true when the network returns.
        status.set('success');
        return undefined as TResult;
      }

      // Rollback is deletion. Nothing was written to the confirmed graph, so there is nothing to
      // restore and no undo log that could have gone stale while the request was in flight.
      await settle(null, groupId);
      error.set(caught);
      status.set('error');
      throw caught;
    }
  }

  /** Drops the group, and the entry behind it when there is one. */
  async function settle(entryId: string | null, groupId: string): Promise<void> {
    if (entryId) await outbox.remove(entryId);
    pending.settle(groupId);
    applied.update((n) => (n > 0 ? n - 1 : 0));
  }

  return {
    mutate,
    status: status.asReadonly(),
    error: error.asReadonly(),
    isPending: computed(() => status() === 'pending'),
    hasPendingWrite: computed(() => applied() > 0),
    conflict: conflict.asReadonly(),
    acknowledgeConflict: () => conflict.set(null),
  };
}

const overlayId = (overlay: EntityOverlay) => `${overlay.typeName}#${overlay.id}`;

/**
 * Finds the disagreement, if the server's answer is one that can disagree.
 *
 * A conflict is only decidable when the response *is* the record: an operation resolving with
 * `void`, an id, or a receipt has not contradicted anything, and reporting one would be inventing a
 * disagreement out of a shape mismatch.
 */
function detectConflict(
  recorded: { overlays: readonly EntityOverlay[]; types: Map<string, EntityType<unknown>> },
  expected: Map<string, unknown>,
  result: unknown,
  store: EntityStore,
): MutationConflict | null {
  if (result === null || typeof result !== 'object') return null;

  for (const overlay of recorded.overlays) {
    if (overlay.removed) continue;

    const type = recorded.types.get(overlay.typeName);
    if (!type || !describes(type, overlay.id, result)) continue;

    const predicted = (expected.get(overlayId(overlay)) ?? store.peekConfirmed(type, overlay.id)) as
      | Record<string, unknown>
      | undefined;
    const actual = result as Record<string, unknown>;

    const paths = Object.keys(overlay.patch).filter((path) => !same(predicted?.[path], actual[path]));
    if (paths.length > 0) {
      return {
        expected: predicted,
        actual: result,
        paths,
        entity: { typeName: overlay.typeName, id: overlay.id },
      };
    }
  }

  return null;
}

/** Whether the response is this record. A `key` that throws on a foreign shape is a "no". */
function describes(type: EntityType<unknown>, id: string, result: unknown): boolean {
  try {
    return type.key(result) === id;
  } catch {
    return false;
  }
}

/**
 * Structural equality, by serialization — adequate because both sides are values that came off the
 * wire moments ago, and a deep-equality helper would be code defending against inputs this path
 * cannot receive.
 */
function same(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}
