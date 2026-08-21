import { Injectable, Signal, computed, signal } from '@angular/core';
import type { OptimisticOverlay, QueuedEntry } from '@braidlabs/data';
import type { EntityType } from './entity';
import type { StoreTransaction } from './store';

/**
 * The optimistic overlay: what the queue predicts, applied over the confirmed graph.
 *
 *     view(record) = confirmed(record) ⊕ pending(record)
 *
 * The important word is *derived*. This used to be an apply-then-undo: a write patched the store,
 * an undo log remembered the previous values, and a failure restored them. Two things went wrong
 * with that, and both are the kind of bug nobody reports as one:
 *
 * 1. **The overlay and the queue could disagree.** A queued mutation lives in storage; its
 *    optimistic effect lived in memory. Reload the page and the work was still queued while the
 *    screen showed the old value — the user's edit apparently lost, then reappearing later when the
 *    queue drained.
 * 2. **Only the app that wrote could see it.** The queue is shared per origin; an undo log is not.
 *
 * Deriving fixes both at once. Rollback becomes deleting an entry, a reload rebuilds the overlay
 * from the queue, and another app's unsent edits show up here because they are in the same store.
 */

/** One record's worth of prediction, in the entity store's terms. */
export interface EntityOverlay {
  readonly typeName: string;
  readonly id: string;
  /** Applied over the confirmed record. Empty for a removal. */
  readonly patch: Record<string, unknown>;
  /** True when the write deletes the record — absence a patch cannot express. */
  readonly removed?: boolean;
}

/**
 * Overlays that belong to one write, so settling or rolling back is one operation.
 *
 * `durable` marks the groups the queue owns: those are replaced wholesale on every re-read of the
 * queue, which is what makes storage the source of truth rather than this signal. Groups that are
 * not durable belong to `durability: 'memory'` mutations — nothing persisted them, so nothing can
 * rebuild them, and they correctly die with the page.
 */
interface OverlayGroup {
  readonly id: string;
  readonly durable: boolean;
  readonly overlays: readonly EntityOverlay[];
}

@Injectable({ providedIn: 'root' })
export class PendingWrites {
  private readonly groups = signal<readonly OverlayGroup[]>([]);

  /** Every pending overlay on the page, in the order the writes were made. */
  readonly overlays: Signal<readonly EntityOverlay[]> = computed(() =>
    this.groups().flatMap((group) => group.overlays),
  );

  /** Whether anything on screen is showing work the server has not confirmed. */
  readonly hasPending = computed(() => this.groups().length > 0);

  /**
   * Records a write's prediction.
   *
   * Applied synchronously, before the entry reaches storage: a UI that waits for IndexedDB to show
   * what the user just typed is a UI that flickers. Storage remains the truth — `syncFromQueue`
   * replaces this the moment the queue is next read.
   */
  add(id: string, overlays: readonly EntityOverlay[], options: { durable: boolean }): void {
    if (overlays.length === 0) return;
    this.groups.update((groups) => [
      ...groups.filter((group) => group.id !== id),
      { id, durable: options.durable, overlays },
    ]);
  }

  /** Drops a group: a confirmation, or a rollback. There is no difference at this level. */
  settle(id: string): void {
    this.groups.update((groups) => groups.filter((group) => group.id !== id));
  }

  /** Re-keys a group once its entry id is known, so the queue's copy replaces the same group. */
  rename(from: string, to: string): void {
    this.groups.update((groups) =>
      groups.map((group) => (group.id === from ? { ...group, id: to, durable: true } : group)),
    );
  }

  /**
   * Rebuilds every durable group from the queue.
   *
   * This is the derivation. Called on every outbox refresh — including the one after rehydrating
   * from storage, which is how a reload gets the overlay back without anything in memory having
   * survived, and how one app comes to show another's unsent edits.
   */
  syncFromQueue(entries: readonly QueuedEntry[]): void {
    const fromQueue = entries
      .filter((entry) => (entry.optimistic ?? []).length > 0)
      .map((entry) => ({
        id: entry.id,
        durable: true,
        overlays: (entry.optimistic ?? []).map(fromOutboxOverlay),
      }));

    this.groups.update((groups) => [...groups.filter((group) => !group.durable), ...fromQueue]);
  }

  /** Sign-out, and tests. */
  clear(): void {
    this.groups.set([]);
  }
}

/** `bulletin#42` — the same key `tag.entity` produces, so one write's tag and overlay agree. */
export function overlayKey(typeName: string, id: string): string {
  return `${typeName}#${id}`;
}

export function toOutboxOverlay(overlay: EntityOverlay): OptimisticOverlay {
  return {
    key: overlayKey(overlay.typeName, overlay.id),
    patch: overlay.patch,
    ...(overlay.removed ? { removed: true } : {}),
  };
}

/**
 * Splits at the *first* `#`, because an id may contain one and a type name may not.
 */
export function fromOutboxOverlay(overlay: OptimisticOverlay): EntityOverlay {
  const at = overlay.key.indexOf('#');
  return {
    typeName: at === -1 ? overlay.key : overlay.key.slice(0, at),
    id: at === -1 ? '' : overlay.key.slice(at + 1),
    patch: overlay.patch,
    ...(overlay.removed ? { removed: true } : {}),
  };
}

/** Applies the overlays for one record, in order. `undefined` means pending removal. */
export function applyOverlays<T>(
  confirmed: T | undefined,
  overlays: readonly EntityOverlay[],
): T | undefined {
  let value = confirmed;
  for (const overlay of overlays) {
    value = overlay.removed ? undefined : ({ ...(value ?? {}), ...overlay.patch } as T);
  }
  return value;
}

/**
 * Runs an `optimistic(tx, input)` callback against a transaction that **records** rather than
 * writes, turning the callback into overlay data.
 *
 * This is what lets the existing config surface stay exactly as it is while the mechanism
 * underneath changes: `tx.patch(Bulletin, id, { status: 'published' })` describes a patch perfectly
 * well, and a closure was never the part that mattered — it just happened to be how the description
 * was expressed. Recording it makes the same description survive a reload, which the closure could
 * never do.
 */
export interface RecordedWrites {
  readonly overlays: EntityOverlay[];
  /**
   * The entity types the callback named, by name.
   *
   * Kept beside the overlays rather than inside them because a type carries a `key` function, and a
   * function cannot be persisted — the overlays go to storage, this map stays in the closure that is
   * waiting on the server.
   */
  readonly types: Map<string, EntityType<unknown>>;
}

export function recordOverlays(apply: (tx: StoreTransaction) => void): RecordedWrites {
  const recorded: EntityOverlay[] = [];
  const types = new Map<string, EntityType<unknown>>();

  const remember = <T>(type: EntityType<T>) => types.set(type.name, type as EntityType<unknown>);

  const tx: StoreTransaction = {
    upsert<T>(type: EntityType<T>, values: T | readonly T[]) {
      remember(type);
      const list = Array.isArray(values) ? (values as readonly T[]) : [values as T];
      for (const value of list) {
        recorded.push({
          typeName: type.name,
          id: type.key(value),
          patch: value as unknown as Record<string, unknown>,
        });
      }
    },
    patch<T>(type: EntityType<T>, id: string, partial: Partial<T>) {
      remember(type);
      recorded.push({ typeName: type.name, id, patch: partial as Record<string, unknown> });
    },
    remove<T>(type: EntityType<T>, id: string) {
      remember(type);
      recorded.push({ typeName: type.name, id, patch: {}, removed: true });
    },
  };

  apply(tx);
  return { overlays: recorded, types };
}
