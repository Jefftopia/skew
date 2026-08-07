import {
  type StepId,
  type Workflow,
  isStepSatisfied,
  pathTo,
  resolveNext,
} from './definition';
import type { WorkflowRun } from './run';

/**
 * Pure transition logic.
 *
 * Kept entirely free of Angular so the interesting behaviour — branching,
 * reachability, progress — can be asserted without mounting anything. This is
 * the module `testWorkflow()` drives, and it is why workflow tests do not need
 * a TestBed.
 */

export interface Progress {
  readonly done: number;
  readonly total: number;
  readonly percent: number;
}

/** Applies a partial update to the run's data. */
export function patchData<TData>(
  run: WorkflowRun<TData>,
  patch: Partial<TData>,
  now: number = Date.now(),
): WorkflowRun<TData> {
  return { ...run, data: { ...run.data, ...patch }, updatedAt: now };
}

/**
 * Moves to the next step, if the current one is satisfied.
 *
 * Returns the unchanged run when blocked, so a caller can advance
 * optimistically without first asking permission.
 */
export function advance<TData>(
  workflow: Workflow<TData>,
  run: WorkflowRun<TData>,
  now: number = Date.now(),
): WorkflowRun<TData> {
  if (!isStepSatisfied(workflow, run.current, run.data)) return run;

  const next = resolveNext(workflow, run.current, run.data);
  if (!next) return run;

  return {
    ...run,
    current: next,
    visited: run.visited.includes(next) ? run.visited : [...run.visited, next],
    updatedAt: now,
  };
}

/** Steps backwards through the visited trail, not raw browser history. */
export function back<TData>(
  run: WorkflowRun<TData>,
  now: number = Date.now(),
): WorkflowRun<TData> {
  const index = run.visited.indexOf(run.current);
  if (index <= 0) return run;
  return { ...run, current: run.visited[index - 1] as StepId, updatedAt: now };
}

/**
 * Jumps to a step, but only if the data makes it genuinely reachable.
 *
 * Returns the step actually landed on. A deep link into step four with step
 * two blank lands on step two — rendering step four would show a form with
 * nothing behind it, and let the user submit a half-built object.
 */
export function goTo<TData>(
  workflow: Workflow<TData>,
  run: WorkflowRun<TData>,
  target: StepId,
  now: number = Date.now(),
): { run: WorkflowRun<TData>; landedOn: StepId; redirected: boolean } {
  if (!workflow.steps[target]) {
    return { run, landedOn: run.current, redirected: true };
  }

  // Going back to somewhere already visited is always allowed — the user is
  // editing an earlier answer, which is the normal way wizards get used.
  if (run.visited.includes(target)) {
    return {
      run: { ...run, current: target, updatedAt: now },
      landedOn: target,
      redirected: false,
    };
  }

  const { reachable, blockedAt } = pathTo(workflow, target, run.data);
  const landedOn = reachable ? target : (blockedAt ?? workflow.firstStep);

  return {
    run: {
      ...run,
      current: landedOn,
      visited: run.visited.includes(landedOn) ? run.visited : [...run.visited, landedOn],
      updatedAt: now,
    },
    landedOn,
    redirected: landedOn !== target,
  };
}

/**
 * Progress along the branch the current data actually selects.
 *
 * Counting every declared step would misreport flows that branch — a user on
 * the short path should not appear stuck at 60%.
 */
export function progress<TData>(workflow: Workflow<TData>, run: WorkflowRun<TData>): Progress {
  const branch: StepId[] = [];
  let cursor: StepId | null = workflow.firstStep;
  const seen = new Set<StepId>();

  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    branch.push(cursor);
    if (!isStepSatisfied(workflow, cursor, run.data)) break;
    cursor = resolveNext(workflow, cursor, run.data);
  }

  const total = Math.max(branch.length, run.visited.length);
  const done = branch.filter((id) => isStepSatisfied(workflow, id, run.data)).length;
  return { done, total, percent: total === 0 ? 0 : Math.round((done / total) * 100) };
}

/** True when every step on the selected branch is satisfied. */
export function isComplete<TData>(workflow: Workflow<TData>, run: WorkflowRun<TData>): boolean {
  let cursor: StepId | null = workflow.firstStep;
  const seen = new Set<StepId>();
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    if (!isStepSatisfied(workflow, cursor, run.data)) return false;
    const next: StepId | null = resolveNext(workflow, cursor, run.data);
    if (!next) return true;
    cursor = next;
  }
  return true;
}
