/**
 * localStorage-backed store for WeeklyContent drafts, versioned with
 * @braid/skew.
 *
 * Storage layout (current builds):
 *
 *   key   "draft:<weekId>"
 *   value JSON of { b: <BUILD_ID of writer>, e: <skew envelope> }
 *
 * Legacy layout (pre-skew builds): the bare v1 WeeklyContent object,
 * i.e. JSON.stringify(draft) with `themeQuote` and no `hymns`. The loader
 * detects that shape and adopts it as a v1 envelope before migrating.
 *
 * Every failure mode is a typed result — callers never see an exception:
 *
 *   'ok'          draft usable (possibly migrated forward, then written back)
 *   'empty'       no draft stored for that week
 *   'ahead'       written by a newer build than this one; data is preserved
 *                 untouched so the newer build can still read it
 *   'corrupt'     unparseable / wrong document type / failed migration or
 *                 validation; the entry is cleared
 *   'unavailable' localStorage itself is inaccessible (private mode, SSR,
 *                 storage disabled)
 */

import { BUILD_ID } from './generated/build-id';
import {
  weeklyContentSchema,
  isWeeklyContent,
  WEEKLY_CONTENT_SCHEMA_NAME,
  WEEKLY_CONTENT_VERSION,
  type WeeklyContent,
} from './weekly-content.schema';

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export type DraftLoadResult =
  | { status: 'ok'; draft: WeeklyContent; migratedFrom?: number }
  | { status: 'empty' }
  | {
      status: 'ahead';
      /** Version found in storage (greater than WEEKLY_CONTENT_VERSION). */
      storedVersion: number;
      /** BUILD_ID of the build that wrote it, when recorded. */
      writtenByBuild?: string;
    }
  | { status: 'corrupt' }
  | { status: 'unavailable' };

export type DraftSaveResult =
  | { status: 'ok' }
  | { status: 'quota-exceeded' }
  | { status: 'unavailable' };

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

const KEY_PREFIX = 'draft:';

function keyFor(weekId: string): string {
  return KEY_PREFIX + weekId;
}

/** localStorage access itself can throw (Safari private mode, SSR, etc.). */
function storage(): Storage | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    return null;
  }
}

interface StoredRecord {
  /** BUILD_ID of the writing build — diagnostic breadcrumb for 'ahead'. */
  b: string;
  /** The skew envelope ({ v, n, d, ... }). */
  e: unknown;
}

function isStoredRecord(x: unknown): x is StoredRecord {
  return (
    typeof x === 'object' &&
    x !== null &&
    typeof (x as StoredRecord).b === 'string' &&
    typeof (x as StoredRecord).e === 'object' &&
    (x as StoredRecord).e !== null
  );
}

function envelopeVersion(e: unknown): number | undefined {
  const v = (e as { v?: unknown } | null)?.v;
  return typeof v === 'number' ? v : undefined;
}

/**
 * Pre-skew builds stored the bare draft object. Recognize that shape so the
 * one deploy boundary we know about (v1 -> v2) heals instead of crashing.
 * A bare object with `weekId` and no envelope markers is adopted as v1.
 */
function looksLikeLegacyDraft(x: unknown): boolean {
  if (typeof x !== 'object' || x === null) return false;
  const o = x as Record<string, unknown>;
  return typeof o['weekId'] === 'string' && !('v' in o) && !('d' in o);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function saveDraft(draft: WeeklyContent): DraftSaveResult {
  const ls = storage();
  if (!ls) return { status: 'unavailable' };

  // write() envelopes the draft at the current version; the result also
  // carries lossyPaths/downgradedFrom when down-writing via { as }, which
  // we never do for our own cache.
  const written = weeklyContentSchema.write(draft);
  const record: StoredRecord = { b: BUILD_ID, e: written.envelope };

  try {
    ls.setItem(keyFor(draft.weekId), JSON.stringify(record));
    return { status: 'ok' };
  } catch {
    // QuotaExceededError (name varies across browsers) — the draft is not
    // persisted, but the app keeps working from memory.
    return { status: 'quota-exceeded' };
  }
}

export function loadDraft(weekId: string): DraftLoadResult {
  const ls = storage();
  if (!ls) return { status: 'unavailable' };

  const key = keyFor(weekId);

  let raw: string | null;
  try {
    raw = ls.getItem(key);
  } catch {
    return { status: 'unavailable' };
  }
  if (raw === null) return { status: 'empty' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Truncated / hand-edited JSON: unrecoverable, clear it.
    clear(ls, key);
    return { status: 'corrupt' };
  }

  // Normalize the three on-disk generations into (envelope, writerBuild).
  let envelope: unknown;
  let writtenByBuild: string | undefined;

  if (isStoredRecord(parsed)) {
    envelope = parsed.e;
    writtenByBuild = parsed.b;
  } else if (looksLikeLegacyDraft(parsed)) {
    // Bare pre-skew draft: adopt as a v1 envelope and let the step chain
    // carry it forward.
    envelope = { v: 1, n: WEEKLY_CONTENT_SCHEMA_NAME, d: parsed };
  } else {
    // Some other build variant wrote an envelope without our wrapper, or
    // the key holds foreign data; hand it to skew as-is and let the name
    // check decide.
    envelope = parsed;
  }

  // A version beyond ours means a newer build wrote this draft. We cannot
  // migrate *forward past* our own knowledge, and we must NOT delete it —
  // the newer build (still cached in another tab, or arriving on next
  // reload) can read it fine. Report it and leave storage untouched.
  const storedVersion = envelopeVersion(envelope);
  if (storedVersion !== undefined && storedVersion > WEEKLY_CONTENT_VERSION) {
    return { status: 'ahead', storedVersion, writtenByBuild };
  }

  const result = weeklyContentSchema.read(envelope);

  switch (result.status) {
    case 'ok': {
      const draft = result.value;
      // Belt and braces: read() already ran the schema validator, but the
      // renderer's crash history earns a local recheck before we vouch.
      if (!isWeeklyContent(draft)) {
        clear(ls, key);
        return { status: 'corrupt' };
      }
      const migratedFrom =
        typeof result.from === 'number' &&
        result.from !== WEEKLY_CONTENT_VERSION
          ? result.from
          : undefined;
      if (migratedFrom !== undefined) {
        // Write back in current form so the migration runs once, not on
        // every read — and so a later cleanup of old steps stays safe.
        saveDraft(draft);
      }
      return { status: 'ok', draft, migratedFrom };
    }

    // Defense in depth: skew's own ahead detection (in case the envelope
    // hid its version from our cheap probe above).
    case 'ahead':
      return {
        status: 'ahead',
        storedVersion: storedVersion ?? WEEKLY_CONTENT_VERSION + 1,
        writtenByBuild,
      };

    // Name mismatch, malformed envelope, failed step, failed validation:
    // the entry can never become a usable draft on this or any future
    // build, so reclaim the key.
    default:
      clear(ls, key);
      return { status: 'corrupt' };
  }
}

export function removeDraft(weekId: string): void {
  const ls = storage();
  if (!ls) return;
  clear(ls, keyFor(weekId));
}

function clear(ls: Storage, key: string): void {
  try {
    ls.removeItem(key);
  } catch {
    // Removal is best-effort; a failure here changes nothing for callers.
  }
}
