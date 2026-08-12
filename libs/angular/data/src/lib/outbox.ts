import { Injectable, Signal, computed, inject, signal } from '@angular/core';
import { type VersionedStore, isOk, versioned } from '@skewkit/core';
import { DATA_OPTIONS } from './config';

/**
 * The durable mutation outbox.
 *
 * This is the piece that cannot be built with in-flight request machinery. A
 * mutation queued while offline has to survive a page reload — and after a
 * reload there is no pending `Promise` to retry, no `HttpRequest` to intercept,
 * and no closure left alive. Only something persisted can be replayed.
 *
 * Which forces one API constraint: an outbox mutation must have a stable `id`,
 * because the *operation* is a closure and closures do not serialise. On
 * replay we look the operation up by id.
 */

export interface OutboxEntry {
  readonly id: string;
  /** Identifies which registered mutation replays this entry. */
  readonly mutationId: string;
  readonly input: unknown;
  /**
   * Payload contract version, carried so an entry queued under one deploy can
   * be migrated before it flushes against a later one.
   */
  readonly schemaVersion: number;
  readonly createdAt: number;
  readonly attempts: number;
  readonly lastError?: string;
}

interface OutboxFile {
  readonly entries: readonly OutboxEntry[];
}

/** Versioned so the queue's own shape can evolve without stranding queued work. */
const OutboxSchema = versioned<OutboxFile>('skew-outbox');

export type OutboxRunner = (input: unknown, entry: OutboxEntry) => Promise<unknown>;

@Injectable({ providedIn: 'root' })
export class OutboxService {
  private readonly options = inject(DATA_OPTIONS);
  private readonly runners = new Map<string, OutboxRunner>();
  private readonly entriesSignal = signal<readonly OutboxEntry[]>([]);
  private readonly flushingSignal = signal(false);

  /** Queued work, oldest first. */
  readonly entries: Signal<readonly OutboxEntry[]> = this.entriesSignal.asReadonly();
  readonly pendingCount = computed(() => this.entriesSignal().length);
  readonly isFlushing = this.flushingSignal.asReadonly();
  readonly hasPendingWork = computed(() => this.entriesSignal().length > 0);

  private store: VersionedStore<OutboxFile> | null = null;
  private loaded = false;

  private get persistence(): VersionedStore<OutboxFile> | null {
    if (!this.options.outboxStore) return null;
    this.store ??= this.options.outboxStore(OutboxSchema);
    return this.store;
  }

  /**
   * Registers how a mutation id replays. Called by `mutation()` at creation,
   * which is why outbox mutations must be constructed during app start-up
   * rather than lazily inside a click handler — otherwise a queued entry has
   * nothing to replay into after a reload.
   */
  register(mutationId: string, runner: OutboxRunner): void {
    this.runners.set(mutationId, runner);
  }

  /** Rehydrates from storage. Safe to call repeatedly. */
  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    const store = this.persistence;
    if (!store) return;

    const result = await store.get('queue');
    if (isOk(result)) {
      this.entriesSignal.set(result.value.entries ?? []);
    } else if (result.reason === 'ahead') {
      // Queued by a newer build than the one now running. Replaying it would
      // send payloads this build does not understand; leave it for the build
      // that wrote it rather than dropping the user's work.
      this.options.onOutboxError?.('outbox written by a newer build; left untouched', result);
    }
  }

  async enqueue(
    entry: Omit<OutboxEntry, 'id' | 'createdAt' | 'attempts'>,
  ): Promise<OutboxEntry> {
    await this.load();
    const full: OutboxEntry = {
      ...entry,
      id: `${entry.mutationId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
      createdAt: Date.now(),
      attempts: 0,
    };
    this.entriesSignal.update((current) => [...current, full]);
    await this.persist();
    return full;
  }

  /**
   * Drains the queue in order.
   *
   * Strictly sequential: entries frequently depend on each other (create, then
   * publish the thing you created), and parallel flushing would race them.
   * A permanently-failing entry is dropped rather than blocking the queue
   * forever — reported through `onOutboxError` so it is never silent.
   */
  async flush(): Promise<{ sent: number; failed: number; remaining: number }> {
    await this.load();
    if (this.flushingSignal()) return { sent: 0, failed: 0, remaining: this.pendingCount() };

    this.flushingSignal.set(true);
    let sent = 0;
    let failed = 0;

    try {
      // Snapshot: entries enqueued mid-flush wait for the next pass.
      for (const entry of [...this.entriesSignal()]) {
        const runner = this.runners.get(entry.mutationId);
        if (!runner) {
          // The mutation no longer exists in this build — it was renamed or
          // removed. Nothing can replay it.
          this.options.onOutboxError?.(
            `no registered mutation for "${entry.mutationId}"; dropping queued entry`,
            entry,
          );
          this.drop(entry.id);
          failed++;
          continue;
        }

        try {
          await runner(entry.input, entry);
          this.drop(entry.id);
          sent++;
        } catch (error) {
          failed++;
          const attempts = entry.attempts + 1;
          if (attempts >= this.options.maxOutboxAttempts) {
            this.options.onOutboxError?.(
              `giving up on "${entry.mutationId}" after ${attempts} attempts`,
              error,
            );
            this.drop(entry.id);
          } else {
            this.update(entry.id, {
              attempts,
              lastError: error instanceof Error ? error.message : String(error),
            });
            // Ordering matters, so a failure stops the drain rather than
            // skipping ahead to entries that may depend on this one.
            break;
          }
        }
      }
      await this.persist();
      return { sent, failed, remaining: this.pendingCount() };
    } finally {
      this.flushingSignal.set(false);
    }
  }

  /** Discards everything. Sign-out, or an explicit "abandon my changes". */
  async clear(): Promise<void> {
    this.entriesSignal.set([]);
    await this.persist();
  }

  private drop(id: string): void {
    this.entriesSignal.update((current) => current.filter((entry) => entry.id !== id));
  }

  private update(id: string, patch: Partial<OutboxEntry>): void {
    this.entriesSignal.update((current) =>
      current.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)),
    );
  }

  private async persist(): Promise<void> {
    const store = this.persistence;
    if (!store) return;
    try {
      await store.set('queue', { entries: this.entriesSignal() });
    } catch (error) {
      this.options.onOutboxError?.('failed to persist the outbox', error);
    }
  }
}
