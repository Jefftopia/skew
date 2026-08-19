/**
 * The worker's own version boundary.
 *
 * A service worker is a long-lived deployment artifact that updates on its own schedule, which
 * makes it a skew vector inside a system whose entire purpose is managing skew. It gets the same
 * discipline as everything else here: it knows its build and the registry snapshot it is serving,
 * and when those disagree with the page it is answering for, it says so.
 *
 * The alternative is the failure worth designing against — a worker that quietly serves yesterday's
 * assets to today's document. That does not look like a worker problem to anyone debugging it. It
 * looks like an application bug, in an application that is fine.
 */

export type SkewSeverity = 'ok' | 'worker-behind' | 'worker-ahead' | 'snapshot-mismatch';

export interface WorkerVersion {
  /** The build this worker script was shipped as. */
  buildId?: string;
  /** The registry snapshot id this worker is composing against. */
  snapshotId?: string;
}

export interface PageVersion {
  buildId?: string;
  snapshotId?: string;
}

export interface SkewDiagnosis {
  severity: SkewSeverity;
  message: string;
  worker: WorkerVersion;
  page: PageVersion;
  /** What to do about it, phrased as an instruction. */
  fixHint?: string;
}

/**
 * Compares the worker's version with the page's.
 *
 * Deliberately not an error: a mismatch is usually transient and self-healing — a deploy landed
 * while a tab was open, and the worker updates on the next navigation. What it must never be is
 * invisible, so this returns something a host can log, report, or show, and the prebuilt worker
 * always logs it.
 */
export function diagnoseSkew(worker: WorkerVersion, page: PageVersion): SkewDiagnosis {
  const base = { worker, page };

  if (worker.snapshotId && page.snapshotId && worker.snapshotId !== page.snapshotId) {
    return {
      ...base,
      severity: 'snapshot-mismatch',
      message:
        `braid-sw: this worker is composing against registry snapshot "${worker.snapshotId}" and the ` +
        `page was rendered against "${page.snapshotId}" — the two disagree about which fragments exist`,
      fixHint:
        'the worker updates on the next navigation; if it persists, the gateway is serving a worker ' +
        'pinned to a snapshot the shell no longer deploys',
    };
  }

  if (worker.buildId && page.buildId && worker.buildId !== page.buildId) {
    // Which side is stale is not decidable from two opaque ids, and guessing would produce a
    // confident, wrong instruction. Both directions are named; the fix is the same either way.
    return {
      ...base,
      severity: 'worker-behind',
      message:
        `braid-sw: worker build "${worker.buildId}" is serving a page built as "${page.buildId}" — ` +
        'assets may be answered from the older build',
      fixHint: 'reload once the worker has activated, or call skipWaiting in your own install handler',
    };
  }

  return { ...base, severity: 'ok', message: 'braid-sw: worker and page agree' };
}

/**
 * The header a gateway-served worker can read its page's build from.
 *
 * A header rather than a query parameter on the script URL, on purpose: baking the build into the
 * worker's URL would change the URL on every deploy, and a changed worker URL is a new worker with
 * its own install-and-wait lifecycle. Configuration churn should not become worker churn.
 */
export const BRAID_BUILD_HEADER = 'x-braid-build';
export const BRAID_SNAPSHOT_HEADER = 'x-braid-snapshot';
