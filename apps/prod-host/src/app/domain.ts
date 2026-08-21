import { versioned } from '@braidlabs/skew';
import { defineWorkflow } from '@braidlabs/angular-workflow';

/**
 * The host's view of the shared contract.
 *
 * This file is deliberately *not* in a shared library, and that is the point.
 * The host and the remote are built and deployed independently, by different
 * pipelines, at different times. Neither can import the other's types — if it
 * could, they would be one deployment and there would be no skew to survive.
 *
 * What they actually share is the **envelope written to storage**: `{ v, data }`.
 * Both sides declare their own understanding of that envelope, and `@braidlabs/skew`
 * reconciles them at the boundary. The wire format is the contract; the code
 * is not.
 *
 * The host is the OLDER party: it knows draft schema v1 and wizard 0.1.
 */

/** Shared with the remote by convention — the same key in the same origin. */
export const DRAFT_KEY = 'skew-demo:draft';

export interface DraftV1 {
  id: string;
  title: string;
  /** In v1 the author is a bare string. */
  author: string;
  body: string;
}

/**
 * Version 1.
 *
 * Records written before `@braidlabs/skew` was adopted carry no envelope at all;
 * those read as v1 too, so there is no backfill to run.
 */
export const DraftSchemaV1 = versioned<DraftV1>('skew-demo-draft');

export interface WizardData {
  title: string;
  author: string;
  body: string;
}

/** The host's wizard: two steps, no review. */
export const wizardV1 = defineWorkflow<WizardData>({
  id: 'skew-demo-wizard',
  initial: { title: '', author: '', body: '' },
  steps: {
    details: {
      route: 'details',
      label: 'Details',
      validate: (d) => d.title.trim().length > 0,
      next: 'body',
    },
    body: {
      route: 'body',
      label: 'Body',
      validate: (d) => d.body.trim().length > 0,
      terminal: true,
      submit: async (d, ctx) => ({
        published: d.title,
        idempotencyKey: ctx.runId,
      }),
    },
  },
});
