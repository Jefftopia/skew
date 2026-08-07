import type { StepId, Workflow } from './definition';
import * as engine from './engine';
import { type WorkflowRun, createRun } from './run';

/**
 * Headless workflow testing.
 *
 * Workflows are exactly the code that breaks in production and is miserable to
 * exercise through a UI — branching, guards, resumption. This drives the pure
 * engine, so a transition can be asserted without a TestBed, a router, or a
 * single rendered component.
 *
 * ```ts
 * const run = testWorkflow(bulletinFlow)
 *   .patch({ templateId: 'missale' })
 *   .advance();
 *
 * expect(run.current()).toBe('parish');
 * ```
 */
export interface WorkflowHarness<TData> {
  current(): StepId;
  data(): TData;
  canAdvance(): boolean;
  isComplete(): boolean;
  progress(): engine.Progress;
  visited(): readonly StepId[];
  runId(): string;

  patch(partial: Partial<TData>): WorkflowHarness<TData>;
  advance(partial?: Partial<TData>): WorkflowHarness<TData>;
  back(): WorkflowHarness<TData>;
  /** Returns the harness; use `current()` to see where it actually landed. */
  goTo(step: StepId): WorkflowHarness<TData>;
  /** Jumps straight to a state, bypassing the path that would reach it. */
  at(step: StepId, data?: Partial<TData>): WorkflowHarness<TData>;
  snapshot(): WorkflowRun<TData>;
}

export function testWorkflow<TData>(
  workflow: Workflow<TData>,
  initial?: Partial<TData>,
): WorkflowHarness<TData> {
  // Spreading a Partial into TData widens the inferred type to `TData & {}`,
  // which then fails to assign back. The merge is sound; assert it once here
  // rather than constraining every generic in the package.
  const seed = { ...workflow.initial, ...(initial ?? {}) } as TData;
  let run = createRun(workflow.id, workflow.firstStep, seed);

  const harness: WorkflowHarness<TData> = {
    current: () => run.current,
    data: () => run.data,
    canAdvance: () => engine.advance(workflow, run) !== run,
    isComplete: () => engine.isComplete(workflow, run),
    progress: () => engine.progress(workflow, run),
    visited: () => run.visited,
    runId: () => run.runId,
    snapshot: () => run,

    patch(partial) {
      run = engine.patchData(run, partial);
      return harness;
    },
    advance(partial) {
      if (partial) run = engine.patchData(run, partial);
      run = engine.advance(workflow, run);
      return harness;
    },
    back() {
      run = engine.back(run);
      return harness;
    },
    goTo(step) {
      run = engine.goTo(workflow, run, step).run;
      return harness;
    },
    at(step, data) {
      if (!workflow.steps[step]) {
        throw new TypeError(`[skew/workflow] "${step}" is not a step of "${workflow.id}"`);
      }
      run = {
        ...run,
        current: step,
        data: { ...run.data, ...(data ?? {}) } as TData,
        visited: run.visited.includes(step) ? run.visited : [...run.visited, step],
      };
      return harness;
    },
  };

  return harness;
}
