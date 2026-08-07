import { Signal, computed, inject, signal } from '@angular/core';
import { CacheRegistry } from './cache-registry';
import { OutboxService } from './outbox';
import { EntityStore, type StoreTransaction } from './store';

/**
 * A write, with the three things every application ends up reimplementing:
 * optimistic application, rollback on failure, and durability.
 */

export type MutationStatus = 'idle' | 'pending' | 'success' | 'error';

export interface MutationConfig<TInput, TResult> {
  /**
   * Stable identifier. Required when `durability: 'outbox'`, because a queued
   * entry outlives the closure and must find its operation again by name after
   * a reload.
   */
  readonly id?: string;
  readonly operation: (input: TInput) => Promise<TResult>;
  /**
   * Applies the change locally before the server has agreed. Everything written
   * through `tx` is rolled back precisely if the operation fails.
   */
  readonly optimistic?: (tx: StoreTransaction, input: TInput) => void;
  /** Normalizes the server's response back into the store. */
  readonly onSuccess?: (store: EntityStore, result: TResult, input: TInput) => void;
  /** Tags to mark stale once the write lands. */
  readonly invalidates?: (input: TInput, result?: TResult) => readonly string[];
  /**
   * `'outbox'` persists the mutation so it survives a reload and replays when
   * connectivity returns. `'memory'` (default) fails fast.
   */
  readonly durability?: 'memory' | 'outbox';
  /** Payload contract version, carried on queued entries. */
  readonly schemaVersion?: number;
}

export interface MutationRef<TInput, TResult> {
  mutate(input: TInput): Promise<TResult>;
  readonly status: Signal<MutationStatus>;
  readonly error: Signal<unknown>;
  readonly isPending: Signal<boolean>;
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

  const durability = config.durability ?? 'memory';
  if (durability === 'outbox' && !config.id) {
    throw new TypeError(
      '[skew/data] a mutation with durability: "outbox" requires a stable `id`. ' +
        'Queued entries outlive the closure and are matched back to their operation by id.',
    );
  }

  const status = signal<MutationStatus>('idle');
  const error = signal<unknown>(undefined);

  // Replay path. Registered eagerly so a queue rehydrated at start-up has
  // somewhere to go — this is why outbox mutations must be created during
  // bootstrap rather than lazily inside a handler.
  if (durability === 'outbox' && config.id) {
    outbox.register(config.id, async (input) => config.operation(input as TInput));
  }

  async function mutate(input: TInput): Promise<TResult> {
    status.set('pending');
    error.set(undefined);

    const tx = store.transaction();
    if (config.optimistic) tx.apply((t) => config.optimistic?.(t, input));

    try {
      const result = await config.operation(input);

      config.onSuccess?.(store, result, input);
      const tags = config.invalidates?.(input, result);
      if (tags?.length) registry.invalidate(...tags);

      status.set('success');
      return result;
    } catch (caught) {
      if (durability === 'outbox' && config.id) {
        // Keep the optimistic state: from the user's point of view the change
        // happened, and it will reach the server when the network returns.
        await outbox.enqueue({
          mutationId: config.id,
          input,
          schemaVersion: config.schemaVersion ?? 1,
        });
        status.set('success');
        return undefined as TResult;
      }

      tx.rollback();
      error.set(caught);
      status.set('error');
      throw caught;
    }
  }

  return {
    mutate,
    status: status.asReadonly(),
    error: error.asReadonly(),
    isPending: computed(() => status() === 'pending'),
  };
}
