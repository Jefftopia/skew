import { inject } from '@angular/core';
import { type CanActivateFn, Router, type Routes } from '@angular/router';
import { WORKFLOW_OPTIONS } from './config';
import { type StepId, type Workflow, pathTo } from './definition';
import { WorkflowRuntime } from './workflow';

/**
 * Router integration — the reason this is a library rather than a state machine.
 *
 * XState is a fine machine and knows nothing about URLs, guards, or what should
 * happen when someone pastes a link to step four into Slack.
 */

/**
 * Blocks deep links into steps the collected data cannot reach yet, redirecting
 * to the furthest step that *is* reachable.
 *
 * Without this, a bookmarked step-four URL renders a form with nothing behind
 * it and lets the user submit a half-built object.
 */
export function workflowGuard<TData>(workflow: Workflow<TData>, step: StepId): CanActivateFn {
  return () => {
    const runtime = inject(WorkflowRuntime);
    const router = inject(Router);
    const basePath = inject(WORKFLOW_OPTIONS).basePath;
    const flow = runtime.attach(workflow);

    // A guard asks a question; it must not mutate the run. `pathTo` is pure.
    if (step === flow.current()) return true;

    const { reachable, blockedAt } = pathTo(workflow, step, flow.data());
    if (reachable) return true;

    const landedOn = blockedAt ?? workflow.firstStep;
    const route = workflow.steps[landedOn]?.route ?? '';
    return router.createUrlTree(basePath ? [basePath, route] : [route]);
  };
}

/**
 * Generates one guarded route per step, plus a redirect from the base path to
 * the first step.
 *
 * ```ts
 * export const routes: Routes = [
 *   {
 *     path: 'bulletins/new',
 *     children: workflowRoutes(bulletinFlow, {
 *       template: () => import('./steps/template').then((m) => m.TemplateStep),
 *       parish:   () => import('./steps/parish').then((m) => m.ParishStep),
 *     }),
 *   },
 * ];
 * ```
 */
export function workflowRoutes<TData>(
  workflow: Workflow<TData>,
  components: Readonly<Record<StepId, () => Promise<unknown>>>,
): Routes {
  const routes: Routes = Object.entries(workflow.steps).map(([id, step]) => ({
    path: step.route,
    loadComponent: components[id] as never,
    canActivate: [workflowGuard(workflow, id)],
  }));

  const first = workflow.steps[workflow.firstStep];
  if (first) {
    routes.push({ path: '', pathMatch: 'full', redirectTo: first.route });
  }
  return routes;
}
