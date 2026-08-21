import { createOutbox, type Outbox, type RecordDriver } from '@braid/data';
import type { AssetReport } from './asset-handler.js';
import type { SkewDiagnosis } from './skew-report.js';

/**
 * Durable reports: telemetry that survives the tab being closed.
 *
 * The worker already knows things nobody else can see — that a chunk was served from cache after the
 * origin 404'd it, that its build disagrees with the page's. Handed to an `onReport` callback those
 * facts are fire-and-forget: a `fetch` started as the tab is closing races page teardown and usually
 * loses, and the reports that go missing are disproportionately the interesting ones. A user hitting
 * a broken deploy is a user who closes the tab.
 *
 * Background Sync fixes exactly that: records are queued durably and flushed when the browser next
 * says it can, whether or not any page is open. It is **Chromium-only**, so this is an enhancement
 * to sending reports rather than a replacement for it — the queue flushes opportunistically too, and
 * a browser without `sync` simply gets the opportunistic path.
 *
 * The queue itself is `@braid/data`'s outbox rather than a second implementation: one record per
 * entry, so appending never reads the queue first and two contexts cannot lose each other's writes.
 * That problem was solved once already, and solving it again here would mean debugging it again too.
 */

export type BraidReport =
  | { kind: 'asset'; at: string; report: AssetReport }
  | { kind: 'skew'; at: string; diagnosis: SkewDiagnosis };

export interface ReportQueueOptions {
  /** Where reports are POSTed, as JSON. */
  endpoint: string;
  /** Storage for the queue. In a worker, `indexedDbRecordDriver()`. */
  driver: RecordDriver;
  /** Distinguishes this worker's reports from anything else sharing the origin's storage. */
  owner?: string;
  /** Batch size per flush. Bounded so one flush cannot become an unbounded upload. */
  batchSize?: number;
  fetch?: typeof fetch;
}

export interface FlushOutcome {
  sent: number;
  /** Entries left queued — the endpoint refused them, and they are still owed. */
  remaining: number;
}

export interface ReportQueue {
  record(report: BraidReport): Promise<void>;
  flush(): Promise<FlushOutcome>;
  pending(): Promise<number>;
}

const REPORT_MUTATION = 'braid-sw.report';

export function createReportQueue(options: ReportQueueOptions): ReportQueue {
  const networkFetch = options.fetch ?? globalThis.fetch;
  const batchSize = options.batchSize ?? 50;

  const outbox: Outbox = createOutbox({
    driver: options.driver,
    owner: options.owner ?? 'braid-sw',
    collection: 'braid-sw-reports',
  });

  return {
    async record(report) {
      await outbox.enqueue({ mutationId: REPORT_MUTATION, input: report });
    },

    async pending() {
      return (await outbox.mine()).length;
    },

    /**
     * Sends what is queued, oldest first, and removes only what the endpoint accepted.
     *
     * One request per batch rather than per record: a worker waking to flush forty reports should
     * not make forty requests, and the endpoint learns more from a batch than from its parts. A
     * refused batch stays queued in full — partial credit would need the endpoint to say which
     * records it took, and no telemetry endpoint does.
     */
    async flush() {
      const entries = (await outbox.mine()).slice(0, batchSize);
      if (entries.length === 0) return { sent: 0, remaining: 0 };

      try {
        const response = await networkFetch(options.endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ reports: entries.map((entry) => entry.input) }),
          // Reports are diagnostics, not a session: sending credentials with them would attach
          // identity to data nobody asked to have attached.
          credentials: 'omit',
          keepalive: true,
        });

        if (!response.ok) {
          await Promise.all(entries.map((entry) => outbox.recordFailure(entry.id, `HTTP ${response.status}`)));
          return { sent: 0, remaining: (await outbox.mine()).length };
        }

        await Promise.all(entries.map((entry) => outbox.remove(entry.id)));
        return { sent: entries.length, remaining: (await outbox.mine()).length };
      } catch (error) {
        // Still offline. The whole point of the queue is that this is survivable, so the entries
        // stay exactly where they are.
        const message = error instanceof Error ? error.message : String(error);
        await Promise.all(entries.map((entry) => outbox.recordFailure(entry.id, message)));
        return { sent: 0, remaining: (await outbox.mine()).length };
      }
    },
  };
}

/** The Background Sync tag this queue registers and answers to. */
export const BRAID_REPORT_SYNC_TAG = 'braid-sw:reports';
