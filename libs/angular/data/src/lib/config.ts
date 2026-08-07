import { InjectionToken } from '@angular/core';
import {
  type VersionedSchema,
  type VersionedStore,
  createVersionedStore,
  webStorageDriver,
} from '@skew/core';

export interface DataOptions {
  /**
   * Builds the persistence used by the outbox.
   *
   * A factory rather than a store, because the outbox owns its own schema and
   * must be the one to supply it. Return `null` to keep the queue in memory —
   * which means queued work is lost on reload, so it is only appropriate when
   * every mutation is fire-and-forget.
   */
  readonly outboxStore?: <T>(schema: VersionedSchema<T>) => VersionedStore<T>;
  /** Attempts before a queued entry is abandoned. Default 5. */
  readonly maxOutboxAttempts: number;
  /**
   * Reports outbox trouble: a dropped entry, a queue written by a newer build,
   * a failed persist.
   *
   * Silent by default, but wiring it to telemetry is how you find out that
   * users are losing queued work — the failure is otherwise invisible, because
   * the user already navigated away believing it saved.
   */
  readonly onOutboxError?: (message: string, detail?: unknown) => void;
  /** Flush the outbox when the browser reports it is back online. Default true. */
  readonly flushOnReconnect: boolean;
}

export const DATA_OPTIONS = new InjectionToken<DataOptions>('SKEW_DATA_OPTIONS');

export interface DataOptionsInput {
  readonly outboxStore?: DataOptions['outboxStore'];
  readonly maxOutboxAttempts?: number;
  readonly onOutboxError?: DataOptions['onOutboxError'];
  readonly flushOnReconnect?: boolean;
  /**
   * Convenience: persist the outbox in Web Storage. Equivalent to supplying
   * `outboxStore` yourself, and adequate for queues of ordinary size.
   */
  readonly persistOutbox?: boolean;
  /** Stamped onto persisted envelopes for attribution. */
  readonly buildId?: string;
}

export function resolveDataOptions(input: DataOptionsInput = {}): DataOptions {
  const outboxStore =
    input.outboxStore ??
    (input.persistOutbox
      ? <T>(schema: VersionedSchema<T>) =>
          createVersionedStore(schema, {
            driver: webStorageDriver('local'),
            ...(input.buildId === undefined ? {} : { buildId: input.buildId }),
          })
      : undefined);

  return {
    ...(outboxStore === undefined ? {} : { outboxStore }),
    maxOutboxAttempts: input.maxOutboxAttempts ?? 5,
    ...(input.onOutboxError === undefined ? {} : { onOutboxError: input.onOutboxError }),
    flushOnReconnect: input.flushOnReconnect ?? true,
  };
}
