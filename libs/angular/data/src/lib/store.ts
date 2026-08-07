import { Injectable, Signal, computed, signal } from '@angular/core';
import type { EntityType } from './entity';

/**
 * The normalized entity store.
 *
 * Components must read from *here*, not from the response object a query
 * resolved. This is the part teams get wrong: if a component holds the parsed
 * response, writing an updated record into the store changes nothing it can
 * observe, and normalization buys you exactly nothing.
 *
 *   ✗ bulletins = this.list.value();          // a private copy that drifts
 *   ✓ bulletins = store.selectAll(Bulletin);  // a view of the shared graph
 */

type EntityTable = ReadonlyMap<string, unknown>;
type StoreState = ReadonlyMap<string, EntityTable>;

/** Records applied within a transaction, so they can be undone. */
interface UndoEntry {
  readonly typeName: string;
  readonly id: string;
  /** `undefined` means "did not exist", so undo removes it. */
  readonly previous: unknown | undefined;
}

/**
 * A batch of writes that can be rolled back wholesale.
 *
 * Optimistic updates need this: the write happens before the server has agreed,
 * so a failure must restore precisely what was there — not "roughly re-fetch".
 */
export interface StoreTransaction {
  upsert<T>(type: EntityType<T>, values: T | readonly T[]): void;
  patch<T>(type: EntityType<T>, id: string, partial: Partial<T>): void;
  remove<T>(type: EntityType<T>, id: string): void;
}

@Injectable({ providedIn: 'root' })
export class EntityStore {
  private readonly state = signal<StoreState>(new Map());

  /**
   * Memoized per `type#id`. Without this, calling `select()` inside a template
   * would mint a fresh computed on every change-detection pass — a subtle and
   * expensive footgun.
   */
  private readonly selectCache = new Map<string, Signal<unknown>>();
  private readonly allCache = new Map<string, Signal<readonly unknown[]>>();

  /** A single record, or `undefined` when absent. */
  select<T>(type: EntityType<T>, id: string): Signal<T | undefined> {
    const cacheKey = `${type.name}#${id}`;
    const existing = this.selectCache.get(cacheKey);
    if (existing) return existing as Signal<T | undefined>;

    const derived = computed(() => this.state().get(type.name)?.get(id) as T | undefined);
    this.selectCache.set(cacheKey, derived);
    return derived;
  }

  /** Every record of a type, in insertion order. */
  selectAll<T>(type: EntityType<T>): Signal<readonly T[]> {
    const existing = this.allCache.get(type.name);
    if (existing) return existing as Signal<readonly T[]>;

    const derived = computed(() => {
      const table = this.state().get(type.name);
      return table ? ([...table.values()] as T[]) : [];
    });
    this.allCache.set(type.name, derived);
    return derived;
  }

  /**
   * A filtered view. Not memoized by predicate — call it once and keep the
   * result, as you would any other `computed`.
   */
  query<T>(type: EntityType<T>, predicate: (value: T) => boolean): Signal<readonly T[]> {
    const all = this.selectAll(type);
    return computed(() => all().filter(predicate));
  }

  /** Reads a record without subscribing. For use inside effects and handlers. */
  peek<T>(type: EntityType<T>, id: string): T | undefined {
    return this.state().get(type.name)?.get(id) as T | undefined;
  }

  upsert<T>(type: EntityType<T>, values: T | readonly T[]): void {
    this.applyWrites(this.toWrites(type, values));
  }

  patch<T>(type: EntityType<T>, id: string, partial: Partial<T>): void {
    const current = this.peek(type, id);
    if (current === undefined) return;
    this.applyWrites([{ typeName: type.name, id, value: { ...current, ...partial } }]);
  }

  remove<T>(type: EntityType<T>, id: string): void {
    this.applyWrites([{ typeName: type.name, id, value: undefined }]);
  }

  /** Empties a type, or the whole store. Mainly for sign-out and tests. */
  clear<T>(type?: EntityType<T>): void {
    if (!type) {
      this.state.set(new Map());
      return;
    }
    const next = new Map(this.state());
    next.delete(type.name);
    this.state.set(next);
  }

  /**
   * Applies writes that can be undone as a unit.
   *
   * ```ts
   * const tx = store.transaction();
   * tx.apply((t) => t.patch(Bulletin, id, { status: 'published' }));
   * // …server says no…
   * tx.rollback();
   * ```
   */
  transaction(): {
    apply(fn: (tx: StoreTransaction) => void): void;
    rollback(): void;
    committed: boolean;
  } {
    const undoLog: UndoEntry[] = [];
    let rolledBack = false;

    const record = (typeName: string, id: string): void => {
      // Only the *first* prior value matters; later writes in the same
      // transaction are intermediate states we never want to restore to.
      if (undoLog.some((entry) => entry.typeName === typeName && entry.id === id)) return;
      undoLog.push({ typeName, id, previous: this.state().get(typeName)?.get(id) });
    };

    const tx: StoreTransaction = {
      upsert: <T>(type: EntityType<T>, values: T | readonly T[]) => {
        const writes = this.toWrites(type, values);
        for (const write of writes) record(write.typeName, write.id);
        this.applyWrites(writes);
      },
      patch: <T>(type: EntityType<T>, id: string, partial: Partial<T>) => {
        record(type.name, id);
        const current = this.peek(type, id);
        if (current === undefined) return;
        this.applyWrites([{ typeName: type.name, id, value: { ...current, ...partial } }]);
      },
      remove: <T>(type: EntityType<T>, id: string) => {
        record(type.name, id);
        this.applyWrites([{ typeName: type.name, id, value: undefined }]);
      },
    };

    return {
      apply(fn) {
        fn(tx);
      },
      rollback: () => {
        if (rolledBack) return;
        rolledBack = true;
        this.applyWrites(
          // Restore in reverse so overlapping writes unwind correctly.
          [...undoLog].reverse().map((entry) => ({
            typeName: entry.typeName,
            id: entry.id,
            value: entry.previous,
          })),
        );
      },
      get committed() {
        return !rolledBack;
      },
    };
  }

  // --- internals ---------------------------------------------------------

  private toWrites<T>(
    type: EntityType<T>,
    values: T | readonly T[],
  ): Array<{ typeName: string; id: string; value: unknown }> {
    const list = Array.isArray(values) ? (values as readonly T[]) : [values as T];
    return list.map((value) => ({
      typeName: type.name,
      id: type.key(value),
      value,
    }));
  }

  /**
   * Single write path, so every mutation produces exactly one signal
   * notification regardless of how many records it touched.
   */
  private applyWrites(writes: ReadonlyArray<{ typeName: string; id: string; value: unknown }>): void {
    if (writes.length === 0) return;

    const next = new Map(this.state());
    const touched = new Map<string, Map<string, unknown>>();

    for (const { typeName, id, value } of writes) {
      let table = touched.get(typeName);
      if (!table) {
        table = new Map(next.get(typeName) ?? []);
        touched.set(typeName, table);
      }
      if (value === undefined) table.delete(id);
      else table.set(id, value);
    }

    for (const [typeName, table] of touched) next.set(typeName, table);
    this.state.set(next);
  }
}
