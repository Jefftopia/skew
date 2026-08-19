import { withLock } from './locks.js';
import { storageKey, type RecordDriver } from './record-store.js';

/**
 * Moving records from one partition to another.
 *
 * A partition is a hard boundary — no read crosses one, which is what makes purge complete and a
 * tenant switch a pointer move. That is the right default and it leaves one real case unserved:
 * **a guest who signs in.** Their cart, their draft, their half-finished form all live in the guest
 * partition, and the signed-in customer is a different partition by construction. Somebody has to
 * carry it across, and "somebody" was previously every application, by hand, differently.
 *
 * The important decision here is what gets copied. **Records move as stored bytes — envelope
 * untouched.** Reading each record through a typed store and writing it back would re-envelope it at
 * *this* build's version, so a record written by a newer app would be silently down-projected on the
 * way across, or dropped for being unreadable. Copying the envelope verbatim means a v3 record
 * arrives as a v3 record: a reader that could project it still can, and one that cannot still gets an
 * honest `ahead` rather than quietly lossy data.
 */

export type PartitionConflictPolicy = 'skip' | 'overwrite';

export interface CopyPartitionOptions {
  driver: RecordDriver;
  /** Where the records are now — a guest partition, usually. */
  from: string;
  /** Where they should end up. */
  to: string;
  /**
   * Which collections to carry across.
   *
   * Named rather than "all", because the answer is rarely all of them: a cart should follow its
   * owner, and a queued mutation usually should not — the outbox belongs to the session that made
   * it, and replaying a guest's queued writes as a signed-in customer changes who performed them.
   */
  collections: readonly string[];
  /**
   * What to do when the destination already holds a record with the same id.
   *
   * `'skip'` by default, and the default matters: the destination is the account the person has
   * actually signed in to, so its own saved cart is the more authoritative of the two. Overwriting
   * it with whatever a guest session left on this device is how someone's real basket disappears.
   */
  onConflict?: PartitionConflictPolicy;
  /**
   * `'move'` clears the source afterwards; `'copy'` (default) leaves it alone.
   *
   * Copy is the safer default because the operation is not atomic — an interrupted move that had
   * already deleted the source would lose the records outright, whereas an interrupted copy leaves
   * two readable partitions and a second attempt to make.
   */
  mode?: 'copy' | 'move';
}

export interface CopyPartitionResult {
  copied: number;
  /** Records the destination already had, left as they were. */
  skipped: number;
  /** Records overwritten in the destination, under `onConflict: 'overwrite'`. */
  replaced: number;
}

/**
 * Copies (or moves) every record in `from` into `to`, across the named collections.
 *
 * ```ts
 * await copyPartition({
 *   driver,
 *   from: guestPartition,
 *   to: tenancy.partition(),
 *   collections: ['cart'],
 *   mode: 'move',
 * });
 * ```
 */
export async function copyPartition(options: CopyPartitionOptions): Promise<CopyPartitionResult> {
  const result: CopyPartitionResult = { copied: 0, skipped: 0, replaced: 0 };

  // Copying a partition onto itself is a no-op rather than an error: the caller is usually deriving
  // both ends from a sign-in that may not have changed anything.
  if (options.from === options.to) return result;

  const onConflict = options.onConflict ?? 'skip';
  const mode = options.mode ?? 'copy';

  // Held so a sign-out purge cannot run through the destination while records are landing in it.
  // Keyed on the destination, which is the partition whose contents this changes.
  const outcome = await withLock(
    `skew:data:partition:${options.to}`,
    async () => {
      for (const collection of options.collections) {
        for (const record of await options.driver.list(collection, options.from)) {
          const destinationId = storageKey(options.to, record.key);
          const existing = await options.driver.get(collection, destinationId);

          if (existing && onConflict === 'skip') {
            result.skipped += 1;
            continue;
          }

          await options.driver.put(collection, {
            // Only the address changes. `envelope` is carried verbatim, so the record keeps the
            // version its writer stamped on it.
            ...record,
            id: destinationId,
            partition: options.to,
          });

          if (existing) result.replaced += 1;
          else result.copied += 1;
        }
      }

      if (mode === 'move') {
        // After every collection, not per collection: a failure partway through has then left the
        // source intact rather than half-emptied.
        for (const collection of options.collections) {
          await options.driver.clearPartition(collection, options.from);
        }
      }

      return result;
    },
    { ifAvailable: false },
  );

  if (!outcome.acquired) {
    throw new Error(
      `[skew/data] could not take the lock for partition "${options.to}" — nothing was copied`,
    );
  }

  return outcome.value;
}
