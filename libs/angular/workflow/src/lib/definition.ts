import { type VersionedSchema, versioned } from '@skew/core';

/**
 * Durable multi-step workflows.
 *
 * The state machine is the easy part; XState has done that for years. What no
 * library owns is the *integration*: step↔route mapping, guard-checked deep
 * links, resumption after refresh, and drafts that survive a deploy. That is
 * what this package is for.
 */

export type StepId = string;

export interface WorkflowContext {
  /**
   * Minted once when the run starts and carried into the terminal submit.
   *
   * Users double-click, networks retry, and a workflow resumed on a second
   * device is still the same intent. Without a key established at the *start*,
   * every one of those produces a duplicate.
   */
  readonly runId: string;
  readonly workflowId: string;
  readonly startedAt: number;
}

export interface StepDefinition<TData> {
  /** URL segment for this step. */
  readonly route: string;
  /** Human label, for progress indicators and breadcrumbs. */
  readonly label?: string;
  /**
   * Whether the collected data satisfies this step. Drives `canAdvance()` and
   * the routing guard. Omit for steps that are purely informational.
   */
  readonly validate?: (data: TData) => boolean;
  /**
   * Where to go next. A function receives the current data, so branching is a
   * plain expression rather than a separate transition table.
   */
  readonly next?: StepId | ((data: TData) => StepId);
  /** Marks the end of the flow. A terminal step usually declares `submit`. */
  readonly terminal?: boolean;
  /** Performs the final, irreversible action. Must be idempotent — see `runId`. */
  readonly submit?: (data: TData, context: WorkflowContext) => Promise<unknown>;
}

export interface WorkflowPersistence<TData> {
  /**
   * Sends the draft to the server. Optional; local persistence alone still
   * survives refresh, just not a change of device.
   */
  readonly remote?: (data: TData, context: WorkflowContext) => Promise<unknown>;
  /** Debounce for remote saves. Default 1500ms. */
  readonly remoteDebounceMs?: number;
}

export interface WorkflowDefinition<TData> {
  readonly id: string;
  /** Starting data for a fresh run. */
  readonly initial: TData;
  readonly steps: Readonly<Record<StepId, StepDefinition<TData>>>;
  /** Step to begin at. Defaults to the first declared. */
  readonly initialStep?: StepId;
  /**
   * Versioning for the *draft*, using `@skew/core`.
   *
   * A draft written under build 41 and resumed under 57 is the same boundary
   * as a client calling a newer server — the counterparty is your own past
   * deployment. Without this, every schema change silently corrupts drafts
   * that are already in flight.
   *
   * Defaults to an unversioned v1 schema, which adopts existing drafts as-is.
   */
  readonly schema?: VersionedSchema<TData>;
  readonly persistence?: WorkflowPersistence<TData>;
}

/** A validated workflow definition. */
export interface Workflow<TData> extends WorkflowDefinition<TData> {
  readonly stepIds: readonly StepId[];
  readonly firstStep: StepId;
  readonly schema: VersionedSchema<TData>;
}

/**
 * Declares a workflow.
 *
 * ```ts
 * export const bulletinFlow = defineWorkflow({
 *   id: 'bulletin-creation',
 *   initial: { templateId: '', parishId: '', body: '' },
 *   steps: {
 *     template: { route: 'template', validate: (d) => !!d.templateId, next: 'parish' },
 *     parish:   { route: 'parish',   validate: (d) => !!d.parishId,
 *                 next: (d) => (d.parishId === 'new' ? 'setup' : 'content') },
 *     setup:    { route: 'setup',    next: 'content' },
 *     content:  { route: 'content',  validate: (d) => d.body.length > 0, next: 'review' },
 *     review:   { route: 'review',   terminal: true,
 *                 submit: (d, ctx) => api.publish(d, { idempotencyKey: ctx.runId }) },
 *   },
 * });
 * ```
 */
export function defineWorkflow<TData>(definition: WorkflowDefinition<TData>): Workflow<TData> {
  const stepIds = Object.keys(definition.steps);

  if (stepIds.length === 0) {
    throw new TypeError(`[skew/workflow] "${definition.id}" declares no steps`);
  }

  const firstStep = definition.initialStep ?? (stepIds[0] as StepId);
  if (!definition.steps[firstStep]) {
    throw new TypeError(
      `[skew/workflow] "${definition.id}" initialStep "${firstStep}" is not a declared step`,
    );
  }

  // Validate transitions up front. A typo in `next` would otherwise surface as
  // a dead end halfway through a user's session.
  for (const [id, step] of Object.entries(definition.steps)) {
    if (typeof step.next === 'string' && !definition.steps[step.next]) {
      throw new TypeError(
        `[skew/workflow] "${definition.id}" step "${id}" points at unknown step "${step.next}"`,
      );
    }
    if (!step.next && !step.terminal) {
      throw new TypeError(
        `[skew/workflow] "${definition.id}" step "${id}" has no \`next\` and is not \`terminal\``,
      );
    }
  }

  const routes = Object.values(definition.steps).map((s) => s.route);
  const duplicate = routes.find((route, index) => routes.indexOf(route) !== index);
  if (duplicate) {
    throw new TypeError(
      `[skew/workflow] "${definition.id}" reuses route "${duplicate}" for more than one step`,
    );
  }

  return {
    ...definition,
    stepIds,
    firstStep,
    schema: definition.schema ?? versioned<TData>(`workflow:${definition.id}`),
  };
}

/** Resolves the next step for the given data, or `null` at a terminal step. */
export function resolveNext<TData>(workflow: Workflow<TData>, from: StepId, data: TData): StepId | null {
  const step = workflow.steps[from];
  if (!step || step.terminal) return null;
  const next = typeof step.next === 'function' ? step.next(data) : step.next;
  return next ?? null;
}

/** True when the step's own validation passes (or it declares none). */
export function isStepSatisfied<TData>(workflow: Workflow<TData>, id: StepId, data: TData): boolean {
  const step = workflow.steps[id];
  if (!step?.validate) return true;
  try {
    return step.validate(data);
  } catch {
    // A throwing validator means "not satisfied" rather than crashing
    // navigation — the user can still see and fix the step.
    return false;
  }
}

/**
 * Walks the flow from the start, following real branches, and reports the
 * steps that must be satisfied before `target` is reachable.
 *
 * This is what makes a deep link safe: arriving at step four with step two
 * blank should send you to step two, not render a form with no data behind it.
 */
export function pathTo<TData>(
  workflow: Workflow<TData>,
  target: StepId,
  data: TData,
): { reachable: boolean; blockedAt: StepId | null; path: StepId[] } {
  const path: StepId[] = [];
  let cursor: StepId | null = workflow.firstStep;
  const seen = new Set<StepId>();

  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    path.push(cursor);
    if (cursor === target) return { reachable: true, blockedAt: null, path };
    if (!isStepSatisfied(workflow, cursor, data)) {
      return { reachable: false, blockedAt: cursor, path };
    }
    cursor = resolveNext(workflow, cursor, data);
  }

  // Target is not on the branch the current data selects.
  return { reachable: false, blockedAt: path[path.length - 1] ?? workflow.firstStep, path };
}
