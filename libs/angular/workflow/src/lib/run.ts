import { type VersionedSchema, versioned } from '@braidlabs/skew';
import type { StepId } from './definition';

/**
 * The persisted shape of an in-flight workflow.
 *
 * Deliberately separate from the user's `TData`: the envelope (which step,
 * which run, when) evolves on our schedule, the payload on theirs. Versioning
 * them together would force a library upgrade to invalidate every draft.
 */
export interface WorkflowRun<TData> {
  /** Idempotency key for the terminal submit. Stable for the life of the run. */
  readonly runId: string;
  readonly workflowId: string;
  readonly current: StepId;
  readonly data: TData;
  /** Steps the user has actually passed through, for back-navigation. */
  readonly visited: readonly StepId[];
  readonly startedAt: number;
  readonly updatedAt: number;
  readonly status: 'active' | 'submitting' | 'submitted';
}

/**
 * Envelope schema, versioned independently of the payload.
 *
 * Note the payload is *not* migrated here — the workflow's own
 * `schema` owns that, and it runs after this unwraps.
 */
export const runSchema: VersionedSchema<WorkflowRun<unknown>> =
  versioned<WorkflowRun<unknown>>('skew-workflow-run');

export function createRun<TData>(
  workflowId: string,
  firstStep: StepId,
  initial: TData,
  now: number = Date.now(),
): WorkflowRun<TData> {
  return {
    runId: newRunId(workflowId),
    workflowId,
    current: firstStep,
    data: initial,
    visited: [firstStep],
    startedAt: now,
    updatedAt: now,
    status: 'active',
  };
}

function newRunId(workflowId: string): string {
  const random =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2, 12);
  return `${workflowId}:${random}`;
}
