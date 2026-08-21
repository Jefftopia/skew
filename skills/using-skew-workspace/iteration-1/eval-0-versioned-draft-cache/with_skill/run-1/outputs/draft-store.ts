/**
 * Draft store for weekly-content, replacing the raw
 * `localStorage.setItem('draft:' + weekId, JSON.stringify(draft))` /
 * `JSON.parse(raw) as WeeklyContent` pair.
 *
 * Every read comes back as a discriminated result, and each failure reason
 * gets its own remedy — most importantly `ahead` (a draft written by a NEWER
 * build than the one running) is surfaced as its own case and the draft is
 * left untouched in storage. Discarding an `ahead` draft destroys good data
 * that merely came from the future (the user's other tab or device that got
 * the new deploy first); the next deploy of this app will read it fine.
 */
import { createVersionedStore, webStorageDriver } from '@braid/skew';
import { BUILD_ID } from './generated/build-id';
import { WeeklyContentSchema, WeeklyContentDraft } from './weekly-content.schema';

// ---------------------------------------------------------------------------
// Keys — kept byte-identical to the legacy code's keys ('draft:' + weekId) so
// drafts persisted before this store existed are found, treated as v1
// (un-enveloped data adopts as v1) and migrated forward on first read.
// ---------------------------------------------------------------------------

const DRAFT_KEY_PREFIX = 'draft:';

function draftKey(weekId: string): string {
  return DRAFT_KEY_PREFIX + weekId;
}

// ---------------------------------------------------------------------------
// The store. webStorageDriver('local') degrades to in-memory storage under
// Safari private mode / disabled cookies / SSR, and swallows quota errors on
// write — a failing cache must never break a save the user asked for.
// ---------------------------------------------------------------------------

/** Swap for a real telemetry sink; kept injectable-free so this file stays framework-agnostic. */
let reportDraftFailure: (message: string, detail: unknown) => void = (message, detail) =>
  // eslint-disable-next-line no-console
  console.warn(`[draft-store] ${message}`, detail);

export function setDraftFailureReporter(reporter: (message: string, detail: unknown) => void): void {
  reportDraftFailure = reporter;
}

const store = createVersionedStore(WeeklyContentSchema, {
  driver: webStorageDriver('local'),
  buildId: BUILD_ID,
  onReadFailure: (key, failure) => reportDraftFailure('unreadable draft', { key, ...failure }),
});

// ---------------------------------------------------------------------------
// Read — one branch per failure reason. Do not collapse this to `valueOr(null)`:
// at this boundary the reasons demand different remedies.
// ---------------------------------------------------------------------------

export type DraftLoadResult =
  /** A draft exists and is in the current shape (migrated on the way out if needed). */
  | { status: 'loaded'; draft: WeeklyContentDraft; migratedFromOlderVersion: boolean }
  /** No draft cached for this week. */
  | { status: 'empty' }
  /**
   * The draft was written by a newer build than this one; the migration steps
   * needed to read it do not exist in this bundle. The draft has been LEFT IN
   * STORAGE. Caller should fall back to fetching current content from the
   * server (and may offer the user a "refresh to update the app" prompt) —
   * never treat this as "no draft, start blank" and never overwrite it
   * silently, or the user's newer work is destroyed.
   */
  | { status: 'newer-build' }
  /** Malformed/non-envelope junk; it has been discarded. Refetch from server. */
  | { status: 'corrupt-discarded' }
  /**
   * A bug in the migration chain (`gap`: a step is missing — the chain was
   * edited or a step lost; `threw`: a migration function threw). Reported via
   * the failure reporter; the draft is left in storage so a fixed build can
   * still read it. Caller should fall back to server content.
   */
  | { status: 'error'; reason: 'gap' | 'threw' };

export async function loadDraft(weekId: string): Promise<DraftLoadResult> {
  const result = await store.get(draftKey(weekId));

  if (result.ok) {
    if (result.value == null) {
      return { status: 'empty' };
    }
    return {
      status: 'loaded',
      draft: result.value,
      migratedFromOlderVersion: result.migratedFrom != null,
    };
  }

  switch (result.reason) {
    case 'ahead':
      // Written by a newer build. Leave the data untouched — do NOT discard.
      return { status: 'newer-build' };

    case 'invalid':
      // Not an envelope / malformed beyond the v1-adoption path. This is the
      // one reason where discarding is correct: the bytes are junk.
      removeRawDraft(weekId);
      return { status: 'corrupt-discarded' };

    case 'gap':
    case 'threw':
      // Migration-chain bug. onReadFailure already reported it. Keep the
      // draft: a patched deploy may still be able to read it.
      return { status: 'error', reason: result.reason };
  }
}

/**
 * Synchronous peek for signal/component initializers — avoids a flash of
 * empty state, since webStorageDriver is synchronous. Returns null when there
 * is no readable draft; use loadDraft() when the failure reason matters.
 */
export function peekDraft(weekId: string): WeeklyContentDraft | null {
  return store.peek(draftKey(weekId));
}

// ---------------------------------------------------------------------------
// Write / delete
// ---------------------------------------------------------------------------

/**
 * Envelope-stamps (schema name + version + BUILD_ID) and persists the draft.
 * Quota/private-mode failures are swallowed by the driver by design: caching
 * failing must never break the save the user asked for.
 */
export async function saveDraft(weekId: string, draft: WeeklyContentDraft): Promise<void> {
  await store.set(draftKey(weekId), draft);
}

/**
 * Explicit removal — for "discard draft" actions and after a successful
 * publish. Never call this in response to an `ahead` read.
 */
export function deleteDraft(weekId: string): void {
  removeRawDraft(weekId);
}

/**
 * Guarded raw removal. The store persists under the exact keys we pass it, so
 * removing the raw localStorage entry is sufficient; the guards keep this
 * safe under SSR and private mode (where the driver fell back to memory and
 * there is nothing in localStorage to remove anyway).
 */
function removeRawDraft(weekId: string): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(draftKey(weekId));
    }
  } catch {
    // Storage unavailable (private mode / SSR) — nothing persisted to remove.
  }
}
