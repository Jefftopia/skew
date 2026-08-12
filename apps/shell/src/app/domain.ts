import { versioned } from '@skewkit/core';
import { defineWorkflow } from '@skewkit/angular-workflow';

/**
 * The demo's premise.
 *
 * Two builds of the same product read and write the *same* records:
 *
 *   App 1 (this shell)      data schema v1, workflow 0.1.123
 *   App 2 (lazy-loaded)     data schema v2, workflow 0.2
 *
 * They share a storage key, exactly as two deployments sharing a browser
 * profile — or a server — would. Everything interesting follows from that.
 */

export const DRAFT_KEY = 'demo-draft';

// --- v1: what App 1 knows ---------------------------------------------------

export interface DraftV1 {
  id: string;
  title: string;
  /** In v1 the author is a bare string. */
  author: string;
  body: string;
}

/** Version 1. Un-enveloped legacy rows also read as this, with no backfill. */
export const DraftSchemaV1 = versioned<DraftV1>('demo-draft');

// --- v2: what App 2 knows ---------------------------------------------------

export interface DraftV2 {
  id: string;
  title: string;
  /** v2 splits the author into a structured value… */
  author: { name: string; email: string };
  body: string;
  /** …and adds a summary that v1 never wrote. */
  summary: string;
}

/**
 * Version 2 — the *same* declaration extended, which is what makes the two
 * builds interoperable in one direction and honestly incompatible in the other.
 */
export const DraftSchemaV2 = DraftSchemaV1.next<DraftV2>(
  'structure the author and add a summary',
  (v1) => ({
    id: v1.id,
    title: v1.title,
    author: { name: v1.author, email: '' },
    body: v1.body,
    summary: v1.body.slice(0, 60),
  }),
);

// --- workflows --------------------------------------------------------------

export interface WizardData {
  title: string;
  author: string;
  body: string;
}

/** App 1 — workflow 0.1.123. Two steps. */
export const wizardV1 = defineWorkflow<WizardData>({
  id: 'demo-wizard',
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
      submit: async (d, ctx) => ({ published: d.title, idempotencyKey: ctx.runId }),
    },
  },
});

export interface WizardDataV2 extends WizardData {
  summary: string;
}

/**
 * App 2 — workflow 0.2. A `review` step was inserted, and the data grew a
 * `summary`. A draft parked mid-wizard under 0.1.123 still opens here.
 */
export const wizardV2 = defineWorkflow<WizardDataV2>({
  id: 'demo-wizard',
  initial: { title: '', author: '', body: '', summary: '' },
  schema: versioned<WizardData>('demo-wizard-data').next<WizardDataV2>(
    'add summary',
    (v1) => ({ ...v1, summary: '' }),
  ),
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
      next: 'review',
    },
    review: {
      route: 'review',
      label: 'Review',
      terminal: true,
      submit: async (d, ctx) => ({ published: d.title, idempotencyKey: ctx.runId }),
    },
  },
});

export const VERSIONS = {
  appOne: { data: '1', workflow: '0.1.123' },
  appTwo: { data: '2', workflow: '0.2' },
} as const;
