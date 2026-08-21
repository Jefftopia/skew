/**
 * Versioned schema for WeeklyContent drafts, built on @braidlabs/skew.
 *
 * Version history
 * ---------------
 *  v1  { weekId, themeQuote, announcements }            (pre-rename builds)
 *  v2  { weekId, scriptureOfWeek, hymns, announcements } (current)
 *
 * The last deploy renamed `themeQuote` -> `scriptureOfWeek` and added
 * `hymns: string[]` in the same release, so both changes live in a single
 * bidirectional step (1 -> 2). The `down` direction exists so a build can
 * down-write a draft for an older reader if it ever needs to
 * (`write({ as: 1 })`); dropping `hymns` on the way down is declared lossy.
 */

import {
  versioned,
  registerSchema,
  type MigrationStep,
  type VersionedSchema,
} from '@braidlabs/skew';

/** Stable wire name for this document type (checked against envelope `n`). */
export const WEEKLY_CONTENT_SCHEMA_NAME = 'bulletin.weekly-content';

/** Current schema version. Bump this whenever a new step is appended. */
export const WEEKLY_CONTENT_VERSION = 2;

/** Current shape (v2). This is the only shape application code sees. */
export interface WeeklyContent {
  weekId: string;
  scriptureOfWeek: string;
  hymns: string[];
  announcements: string[];
}

/** Historical shape (v1) — kept private to the migration layer. */
interface WeeklyContentV1 {
  weekId: string;
  themeQuote: string;
  announcements: string[];
}

/**
 * Runtime validator for the *current* shape. Skew runs this after the last
 * migration step, so a draft that survives `read()` is guaranteed to be a
 * well-formed v2 document — no more `undefined` surprises deep in the
 * renderer.
 */
export function isWeeklyContent(value: unknown): value is WeeklyContent {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['weekId'] === 'string' &&
    typeof v['scriptureOfWeek'] === 'string' &&
    Array.isArray(v['hymns']) &&
    (v['hymns'] as unknown[]).every((h) => typeof h === 'string') &&
    Array.isArray(v['announcements']) &&
    (v['announcements'] as unknown[]).every((a) => typeof a === 'string')
  );
}

const steps: MigrationStep[] = [
  {
    from: 1,
    to: 2,
    // themeQuote -> scriptureOfWeek, and hymns gets a safe default.
    up: (d: WeeklyContentV1): WeeklyContent => {
      const { themeQuote, ...rest } = d;
      return {
        ...rest,
        scriptureOfWeek: themeQuote ?? '',
        hymns: [],
        announcements: rest.announcements ?? [],
      };
    },
    // Down-write for older readers: rename back, drop hymns (lossy).
    down: (d: WeeklyContent): WeeklyContentV1 => {
      const { scriptureOfWeek, hymns: _hymns, ...rest } = d;
      return {
        ...rest,
        themeQuote: scriptureOfWeek,
      };
    },
    // Paths that do not survive the down direction; surfaced on write
    // results as `lossyPaths` so callers can warn before down-writing.
    lossyPaths: ['hymns'],
    // Paths synthesized (not carried) by the up direction.
    derivedPaths: ['hymns'],
  },
];

export const weeklyContentSchema: VersionedSchema<WeeklyContent> =
  versioned<WeeklyContent>({
    name: WEEKLY_CONTENT_SCHEMA_NAME,
    version: WEEKLY_CONTENT_VERSION,
    steps,
    validate: isWeeklyContent,
  });

// Module-level registry: makes the schema discoverable by name and lets
// skew detect fingerprint conflicts if two builds ever register different
// step chains under the same name.
registerSchema(weeklyContentSchema);
