import { DestroyRef, Signal, computed, inject, signal } from '@angular/core';
import { CacheRegistry } from './cache-registry';
import type { EntityType } from './entity';
import { EntityStore } from './store';

/**
 * A read that normalizes into the shared store.
 *
 * Angular's own `resource()` / `httpResource()` cannot do this: there is no
 * integration point that lets a third-party store observe what they fetched.
 * So this is a parallel primitive rather than an extension — duplication we
 * would happily delete if the framework grew the hook.
 */

export type QueryStatus = 'idle' | 'loading' | 'success' | 'error';

export interface QueryConfig<T> {
  /** Fetches the data. Anything promise-returning. */
  readonly loader: () => Promise<T>;
  /**
   * Entity types present in the response. Every matching record is written to
   * the store, so other views of the same entity update automatically.
   */
  readonly normalize?: EntityType<any> | ReadonlyArray<EntityType<any>>;
  /** Tags this query depends on; invalidating any of them re-runs it. */
  readonly tags?: () => readonly string[];
  /** Run immediately on creation. Default true. */
  readonly immediate?: boolean;
}

export interface QueryRef<T> {
  readonly value: Signal<T | undefined>;
  readonly status: Signal<QueryStatus>;
  readonly error: Signal<unknown>;
  readonly isLoading: Signal<boolean>;
  /** Re-runs the loader, bypassing any tag bookkeeping. */
  reload(): Promise<void>;
}

/**
 * Creates a query. Must be called in an injection context.
 *
 * ```ts
 * readonly bulletins = query({
 *   loader: () => firstValueFrom(this.http.get<Bulletin[]>('/api/bulletins')),
 *   normalize: Bulletin,
 *   tags: () => ['bulletins'],
 * });
 *
 * // Read through the store, not through `bulletins.value()`:
 * readonly rows = this.store.selectAll(Bulletin);
 * ```
 */
export function query<T>(config: QueryConfig<T>): QueryRef<T> {
  const store = inject(EntityStore);
  const registry = inject(CacheRegistry);
  const destroyRef = inject(DestroyRef);

  const value = signal<T | undefined>(undefined);
  const status = signal<QueryStatus>('idle');
  const error = signal<unknown>(undefined);

  /**
   * Guards against a slow earlier request resolving after a newer one and
   * overwriting fresher data — the classic out-of-order response bug.
   */
  let generation = 0;

  async function run(): Promise<void> {
    const current = ++generation;
    status.set('loading');
    error.set(undefined);

    try {
      const result = await config.loader();
      if (current !== generation) return;

      if (config.normalize) normalizeInto(store, config.normalize, result);

      value.set(result);
      status.set('success');
    } catch (caught) {
      if (current !== generation) return;
      error.set(caught);
      status.set('error');
    }
  }

  if (config.tags) {
    const dispose = registry.subscribe(config.tags, () => void run());
    destroyRef.onDestroy(dispose);
  }

  if (config.immediate ?? true) void run();

  return {
    value: value.asReadonly(),
    status: status.asReadonly(),
    error: error.asReadonly(),
    isLoading: computed(() => status() === 'loading'),
    reload: run,
  };
}

/**
 * Walks a payload and writes every recognised entity into the store.
 *
 * Handles the shapes real APIs return: a bare record, an array, or an envelope
 * such as `{ items: [...] }`. Anything unrecognised is left alone rather than
 * guessed at — a wrong write into the shared graph is worse than no write.
 */
export function normalizeInto(
  store: EntityStore,
  types: EntityType<any> | ReadonlyArray<EntityType<any>>,
  payload: unknown,
): void {
  const list = Array.isArray(types) ? types : [types];
  for (const type of list) {
    for (const candidate of collectCandidates(payload)) {
      let id: string | undefined;
      try {
        id = type.key(candidate);
      } catch {
        continue; // not this type
      }
      if (typeof id === 'string' && id.length > 0) store.upsert(type, candidate);
    }
  }
}

function collectCandidates(payload: unknown): unknown[] {
  if (payload === null || payload === undefined) return [];
  if (Array.isArray(payload)) return payload.filter(isRecord);
  if (!isRecord(payload)) return [];

  // A single record, plus one level of common envelope shapes.
  const nested = Object.values(payload).filter(Array.isArray).flat().filter(isRecord);
  return [payload, ...nested];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
