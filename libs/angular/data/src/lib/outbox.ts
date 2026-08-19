import { Injectable, Signal, computed, inject, signal } from '@angular/core';
import { createOutbox, outboxFlushLock, withLock, type Outbox, type OptimisticOverlay, type QueuedEntry } from '@skewkit/data';
import { DATA_OPTIONS, OUTBOX_COLLECTION } from './config';
import { PendingWrites } from './overlay';

/**
 * The durable mutation outbox, as an Angular service over `@skewkit/data`.
 *
 * This is the piece that cannot be built with in-flight request machinery. A mutation queued while
 * offline has to survive a page reload — and after a reload there is no pending `Promise` to retry,
 * no `HttpRequest` to intercept, and no closure left alive. Only something persisted can be
 * replayed.
 *
 * Which forces one API constraint: an outbox mutation must have a stable `id`, because the
 * *operation* is a closure and closures do not serialise. On replay we look the operation up by id.
 *
 * **The store is shared and the entries are owned.** Persistence lives in `@skewkit/data`, one
 * record per entry, in a store every app on the origin reads. This service replays only what it
 * owns. Previously the queue was a single blob under one key, so a second app overwrote the first's
 * and then dropped its entries for having no registered runner — silently, unless `onOutboxError`
 * happened to be wired.
 */

/** A queued entry as this app sees it. */
export type OutboxEntry = QueuedEntry;

export type OutboxRunner = (input: unknown, entry: OutboxEntry) => Promise<unknown>;

export interface FlushResult {
  sent: number;
  failed: number;
  remaining: number;
  /**
   * True when this call did no work because someone else was already flushing — another tab, or a
   * re-entrant call.
   *
   * Distinct from `sent === 0`, which also happens when the flush *ran* and everything failed.
   * Conflating them makes a failing server look like a busy tab, which sends whoever is debugging
   * in exactly the wrong direction.
   */
  skipped: boolean;
}

@Injectable({ providedIn: 'root' })
export class OutboxService {
  private readonly options = inject(DATA_OPTIONS);
  private readonly pending = inject(PendingWrites);
  private readonly runners = new Map<string, OutboxRunner>();

  private readonly mineSignal = signal<readonly OutboxEntry[]>([]);
  private readonly foreignSignal = signal<readonly OutboxEntry[]>([]);
  private readonly flushingSignal = signal(false);

  /** This app's queued work, oldest first — what it can actually replay. */
  readonly entries: Signal<readonly OutboxEntry[]> = this.mineSignal.asReadonly();
  /**
   * Work queued by another app on this page. Waiting, not stuck: it replays when its owner is
   * mounted. Surfaced so an app can render "someone has unsent changes" honestly rather than
   * reporting only what it can see of the queue.
   */
  readonly foreignEntries: Signal<readonly OutboxEntry[]> = this.foreignSignal.asReadonly();

  /**
   * Unsent work across the whole page, not just this app's.
   *
   * "Are there unsent changes?" is a page-wide question, and each app answering only for itself is
   * how the indicator was wrong before. Use {@link entries} when you need what *this* app owns.
   */
  readonly pendingCount = computed(() => this.mineSignal().length + this.foreignSignal().length);
  readonly hasPendingWork = computed(() => this.pendingCount() > 0);
  readonly isFlushing = this.flushingSignal.asReadonly();

  private outbox: Outbox | null = null;
  private loaded = false;

  private get queue(): Outbox {
    this.outbox ??= createOutbox({
      driver: this.options.driver,
      owner: this.options.owner,
      collection: OUTBOX_COLLECTION,
      ...(this.options.buildId === undefined ? {} : { buildId: this.options.buildId }),
    });
    return this.outbox;
  }

  /**
   * Registers how a mutation id replays. Called by `mutation()` at creation, which is why outbox
   * mutations must be constructed during app start-up rather than lazily inside a click handler —
   * otherwise a queued entry has nothing to replay into after a reload.
   */
  register(mutationId: string, runner: OutboxRunner): void {
    this.runners.set(mutationId, runner);
  }

  /** Rehydrates from storage. Safe to call repeatedly. */
  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    await this.refresh();
  }

  async enqueue(entry: {
    mutationId: string;
    input: unknown;
    schemaVersion?: number;
    /** What readers should show for the records this entry changes, until it is confirmed. */
    optimistic?: OptimisticOverlay[];
  }): Promise<OutboxEntry> {
    await this.load();

    const id = await this.queue.enqueue(entry);
    await this.refresh();

    const queued = this.mineSignal().find((candidate) => candidate.id === id);
    if (!queued) throw new Error(`[skew/data] the outbox did not retain entry "${id}"`);
    return queued;
  }

  /**
   * Drains this app's queue in order.
   *
   * Strictly sequential: entries frequently depend on each other (create, then publish the thing you
   * created), and parallel flushing would race them. A permanently-failing entry is abandoned rather
   * than blocking the queue forever — reported through `onOutboxError` so it is never silent.
   *
   * Only this app's entries are touched. Another app's queued work is left exactly where it is.
   */
  async flush(): Promise<FlushResult> {
    await this.load();
    if (this.flushingSignal()) return { sent: 0, failed: 0, remaining: this.pendingCount(), skipped: true };

    // Held across every tab and realm, not just this instance. Storage is shared per origin, so
    // without it each open tab drains the same queue on reconnect — replaying the same mutations
    // repeatedly, against a server that is by definition just coming back.
    //
    // Declined rather than queued: a flush waiting behind another tab's would run against a queue
    // that tab had already drained. Per owner, so a different application flushing its own disjoint
    // entries is not made to wait for something unrelated.
    const outcome = await withLock(outboxFlushLock(this.options.owner), () => this.drain());

    if (!outcome.acquired) {
      // Another tab is on it. Its writes land in the shared store, so refresh to see them.
      await this.refresh();
      return { sent: 0, failed: 0, remaining: this.pendingCount(), skipped: true };
    }

    return { ...outcome.value, skipped: false };
  }

  private async drain(): Promise<{ sent: number; failed: number; remaining: number }> {
    this.flushingSignal.set(true);
    let sent = 0;
    let failed = 0;

    try {
      // Snapshot: entries enqueued mid-flush wait for the next pass.
      for (const entry of [...this.mineSignal()]) {
        const runner = this.runners.get(entry.mutationId);

        if (!runner) {
          // This app owns the entry but no longer has the mutation — renamed or removed between
          // deploys. Nothing here can replay it, and no other app will claim it either.
          this.options.onOutboxError?.(
            `no registered mutation for "${entry.mutationId}"; dropping queued entry`,
            entry,
          );
          await this.queue.remove(entry.id);
          failed++;
          continue;
        }

        try {
          await runner(entry.input, entry);
          await this.queue.remove(entry.id);
          sent++;
        } catch (error) {
          failed++;
          const message = error instanceof Error ? error.message : String(error);
          const attempts = await this.queue.recordFailure(entry.id, message);

          if (attempts >= this.options.maxOutboxAttempts) {
            this.options.onOutboxError?.(
              `giving up on "${entry.mutationId}" after ${attempts} attempts`,
              error,
            );
            await this.queue.remove(entry.id);
          } else {
            // Ordering matters, so a failure stops the drain rather than skipping ahead to entries
            // that may depend on this one.
            break;
          }
        }
      }

      await this.refresh();
      return { sent, failed, remaining: this.pendingCount() };
    } finally {
      this.flushingSignal.set(false);
    }
  }

  /**
   * Removes one entry, and with it the overlay derived from it.
   *
   * What a confirmation does, and equally what a rollback does — at this level they are the same
   * operation, which is the point of deriving the optimistic view rather than keeping an undo log.
   */
  async remove(id: string): Promise<void> {
    await this.load();
    await this.queue.remove(id);
    await this.refresh();
  }

  /**
   * Discards this app's queued work. Sign-out, or an explicit "abandon my changes".
   *
   * Another app's entries survive: discarding work this app never queued and cannot replay would be
   * deciding on someone else's behalf.
   */
  async clear(): Promise<void> {
    await this.load();
    for (const entry of await this.queue.mine()) await this.queue.remove(entry.id);
    await this.refresh();
  }

  /**
   * Re-reads the shared store into signals. The store is the truth; signals are a view of it.
   *
   * The optimistic overlay is rebuilt here too, from the same read. That is what makes the overlay
   * derived rather than remembered: a reload, another app's write, and a rolled-back entry all reach
   * the screen through this one path, because all three are just a different queue.
   */
  private async refresh(): Promise<void> {
    const [mine, foreign] = await Promise.all([this.queue.mine(), this.queue.foreign()]);
    this.mineSignal.set(mine);
    this.foreignSignal.set(foreign);
    this.pending.syncFromQueue([...mine, ...foreign]);
  }
}
