import { versioned } from '@braidlabs/skew';
import { defineWorkflow } from '@braidlabs/angular-workflow';

/**
 * The remote's view of the same contract.
 *
 * This is a near-copy of the host's `domain.ts`, and the duplication is
 * deliberate. The two apps are built by separate pipelines and cannot import
 * each other; a shared library would make them one deployment and delete the
 * problem this demo exists to show.
 *
 * What a remote team actually does is exactly what is done here: take the
 * shape that is live today, declare it as the base, and extend it with
 * `.next()`. The migration closes over its own snapshot of v1 — it never
 * references the live `DraftV2` interface, because a migration that imports a
 * current type silently changes meaning the next time that type is edited, and
 * then starts lying about what it produces.
 *
 * The remote is the NEWER party: draft schema v2, wizard 0.2.
 */

export const DRAFT_KEY = 'skew-demo:draft';

/** v1, frozen as the remote received it. Never edited again. */
interface DraftV1 {
  id: string;
  title: string;
  author: string;
  body: string;
}

export interface DraftV2 {
  id: string;
  title: string;
  /** v2 splits the bare author string into a structured value… */
  author: { name: string; email: string };
  body: string;
  /** …and adds a summary v1 never wrote. */
  summary: string;
}

export const DraftSchemaV2 = versioned<DraftV1>(
  'skew-demo-draft',
).next<DraftV2>('structure the author and derive a summary', {
  up: (v1) => ({
    id: v1.id,
    title: v1.title,
    author: { name: v1.author, email: '' },
    body: v1.body,
    summary: v1.body.slice(0, 60),
  }),
  /**
   * The projection back onto v1 — what a v1-only reader should see of a v2
   * record. It exists here, in the newer build, because the newer build is
   * the only party that *can* know it. It does nothing at all until this
   * build shares it (`registerSchema`, driven by walkthrough step 5): until
   * then the host's read of a v2 record refuses with `ahead`, exactly as
   * steps 3–4 demonstrate.
   */
  down: (v2) => ({
    id: v2.id,
    title: v2.title,
    author: v2.author.name,
    body: v2.body,
  }),
  derives: ['author.email', 'summary'],
  lossy: ['author.email', 'summary'],
});

interface WizardData {
  title: string;
  author: string;
  body: string;
}

export interface WizardDataV2 extends WizardData {
  summary: string;
}

/**
 * The wizard's *payload* schema, versioned separately from the run envelope.
 *
 * Two things version independently here, and conflating them is a trap: the
 * envelope (which step, which run, when) belongs to the library and evolves on
 * its schedule; the payload belongs to the application. Versioning them
 * together would make a library upgrade invalidate every user's draft.
 *
 * Exported because the editor migrates a parked draft explicitly — see the
 * note on `wizardV2` below.
 */
export const WizardDataSchemaV2 = versioned<WizardData>(
  'skew-demo-wizard-data',
).next<WizardDataV2>('add summary', (v1) => ({ ...v1, summary: '' }));

/**
 * Wizard 0.2 — a `review` step inserted between `body` and submission, and a
 * `summary` field the host's 0.1 never wrote.
 *
 * **This definition is not attached with `injectWorkflow` when the host loads
 * this remote, and that is not an oversight.** `WorkflowRuntime.attach()`
 * deduplicates by workflow *id* so that two components binding the same flow
 * share one run instead of racing each other's drafts — correct behaviour, and
 * exactly what you want inside a single build.
 *
 * Across a federation boundary it has a consequence worth knowing: the host and
 * this remote both declare id `skew-demo-wizard`, they share one runtime, and
 * so **whichever build attaches first wins**. The host's page attaches 0.1
 * before you ever reach here, so calling `injectWorkflow(wizardV2)` would hand
 * back the host's 0.1 run — silently, with the `review` step missing and the
 * payload never migrated.
 *
 * The editor therefore reads the parked draft itself, which is what actually
 * happens on any page load where only this build is running. The definition
 * stays here as the source of truth for what 0.2 *is*.
 */
export const wizardV2 = defineWorkflow<WizardDataV2>({
  id: 'skew-demo-wizard',
  initial: { title: '', author: '', body: '', summary: '' },
  schema: WizardDataSchemaV2,
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
      submit: async (d, ctx) => ({
        published: d.title,
        idempotencyKey: ctx.runId,
      }),
    },
  },
});
