import {
  type EnvironmentProviders,
  InjectionToken,
  makeEnvironmentProviders,
} from '@angular/core';
import {
  type VersionedSchema,
  type VersionedStore,
  createVersionedStore,
  webStorageDriver,
} from '@braidlabs/skew';

export interface WorkflowOptions {
  /**
   * Persistence for drafts. Return `null` to keep runs in memory, which means
   * a refresh loses the user's progress — appropriate only for short flows
   * with nothing worth resuming.
   */
  readonly draftStore?: <T>(schema: VersionedSchema<T>) => VersionedStore<T>;
  /**
   * Route prefix the workflow's step routes live under, used for navigation.
   * Omit to run the workflow without touching the URL.
   */
  readonly basePath?: string;
  /**
   * Reports draft trouble: a draft from a newer build, a failed migration, a
   * storage write that did not land.
   *
   * Worth wiring to telemetry — a draft that silently fails to save looks
   * identical to one that saved, right up until the user comes back.
   */
  readonly onDraftError?: (message: string, detail?: unknown) => void;
}

export const WORKFLOW_OPTIONS = new InjectionToken<WorkflowOptions>('SKEW_WORKFLOW_OPTIONS');

export interface WorkflowOptionsInput extends Omit<WorkflowOptions, 'draftStore'> {
  readonly draftStore?: WorkflowOptions['draftStore'];
  /** Convenience: persist drafts in Web Storage. */
  readonly persistDrafts?: boolean;
  readonly buildId?: string;
}

export function resolveWorkflowOptions(input: WorkflowOptionsInput = {}): WorkflowOptions {
  const draftStore =
    input.draftStore ??
    (input.persistDrafts === false
      ? undefined
      : <T>(schema: VersionedSchema<T>) =>
          createVersionedStore(schema, {
            driver: webStorageDriver('local'),
            ...(input.buildId === undefined ? {} : { buildId: input.buildId }),
          }));

  return {
    ...(draftStore === undefined ? {} : { draftStore }),
    ...(input.basePath === undefined ? {} : { basePath: input.basePath }),
    ...(input.onDraftError === undefined ? {} : { onDraftError: input.onDraftError }),
  };
}

/**
 * Enables workflows.
 *
 * ```ts
 * provideSkewWorkflow({
 *   basePath: '/bulletins/new',
 *   buildId: BUILD_ID,
 *   onDraftError: (message, detail) => telemetry.warn(message, detail),
 * });
 * ```
 */
export function provideSkewWorkflow(input: WorkflowOptionsInput = {}): EnvironmentProviders {
  return makeEnvironmentProviders([
    { provide: WORKFLOW_OPTIONS, useValue: resolveWorkflowOptions(input) },
  ]);
}
