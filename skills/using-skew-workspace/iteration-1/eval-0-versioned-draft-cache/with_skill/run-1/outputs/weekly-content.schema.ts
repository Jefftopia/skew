/**
 * Versioned schema for weekly-content drafts cached in localStorage.
 *
 * A cached draft is a message from a past deployment: build 41 wrote it,
 * build 57 reads it. `JSON.parse(raw) as WeeklyContent` is an assertion, not
 * a check — it is exactly how the themeQuote -> scriptureOfWeek rename broke
 * old drafts. This schema stamps every draft with the version it was authored
 * under and migrates it forward on read.
 *
 * Rules that protect user data (do not relax them):
 *
 * 1. The `WeeklyContentV*` interfaces below are FROZEN SNAPSHOTS — copies of
 *    the shape as it existed at that version. Never replace them with imports
 *    of the live `WeeklyContent` model: the moment a migration references a
 *    live type, editing that type silently changes what old migrations
 *    produce.
 *
 * 2. Never edit or reorder an existing `.next()` step. Data already written
 *    under a version is decoded by that exact step forever. New shape =>
 *    append a new step. Discovered a bug in an old step => append a
 *    *correcting* step.
 *
 * 3. Un-enveloped data is treated as v1. The pre-skew drafts written with
 *    `localStorage.setItem('draft:' + weekId, JSON.stringify(draft))` carry
 *    no envelope, so v1 below is declared as that legacy shape (with
 *    `themeQuote`, without `hymns`) and those drafts upgrade automatically
 *    the first time they are read. No backfill needed.
 */
import { versioned, registerSchema } from '@skew/core';

// ---------------------------------------------------------------------------
// Frozen snapshots — one interface per version, copied, never imported.
// If the real persisted drafts carried more fields than listed here, add them
// to *both* snapshots; unknown extra fields are preserved at runtime anyway
// because the migration spreads the previous payload.
// ---------------------------------------------------------------------------

/**
 * v1 — the shape the app persisted before the last deploy.
 * This is also the shape assigned to legacy, un-enveloped drafts.
 */
interface WeeklyContentV1 {
  weekId: string;
  announcements: { title: string; body: string }[];
  massIntentions: { date: string; intention: string }[];
  /** Renamed to `scriptureOfWeek` in v2. */
  themeQuote?: string;
}

/**
 * v2 — the current shape: `themeQuote` renamed to `scriptureOfWeek`,
 * `hymns` introduced.
 */
interface WeeklyContentV2 {
  weekId: string;
  announcements: { title: string; body: string }[];
  massIntentions: { date: string; intention: string }[];
  scriptureOfWeek?: string;
  hymns: string[];
}

// ---------------------------------------------------------------------------
// The chain IS the schema (no terminal .build()). Each .next() typechecks
// against the previous snapshot, so a migration that doesn't produce the next
// shape is a compile error. The name 'weekly-content' is checked against the
// envelope on read — a 'parish' envelope will not be misread as a draft.
// ---------------------------------------------------------------------------

export const WeeklyContentSchema = versioned<WeeklyContentV1>('weekly-content')
  .next<WeeklyContentV2>(
    'rename themeQuote to scriptureOfWeek; introduce hymns',
    (p) => {
      const { themeQuote, ...rest } = p;
      return {
        ...rest,
        scriptureOfWeek: themeQuote,
        hymns: [],
      };
    },
  );

// Explicit registration — import side effects are not relied upon. The
// registry is also what lets an older build learn about newer steps via
// contract documents, should we ever ship one for this schema.
registerSchema(WeeklyContentSchema);

/**
 * The current draft shape, i.e. what `read()`/`get()` always return after
 * migration. The live application model (src/app/models/weekly-content.model.ts)
 * should be kept structurally compatible with this alias; when it changes
 * shape again, freeze a `WeeklyContentV3` snapshot here and append a new
 * `.next()` step — do NOT edit V1/V2 or the existing step.
 */
export type WeeklyContentDraft = WeeklyContentV2;
