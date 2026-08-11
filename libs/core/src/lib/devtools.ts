/**
 * The devtools trace hook.
 *
 * Follows the React-devtools pattern: a tool that wants to observe skew
 * activity installs a global hook *before* the app boots, and the library
 * emits one event per `read()` / `write()` into it. When no hook is
 * installed (production, tests, every app that never opens the tools) the
 * cost is one property lookup per call and nothing is retained.
 *
 * Events deliberately carry versions, reasons, and paths — never payloads.
 * Payload capture is a tool-side, opt-in concern (drafts contain user data);
 * the library's default must be safe to leave enabled everywhere.
 */

/** One observed schema operation. */
export interface SkewTraceEvent {
  readonly kind: 'read' | 'write';
  /** Schema / contract name. */
  readonly schema: string;
  /**
   * Version the data claimed (envelope `v`, or the assumed version for bare
   * data). For writes: the version of the value being written (the chain's
   * current version).
   */
  readonly from: number;
  /**
   * The reader's current version (reads), or the target version being
   * written at (writes — differs from `from` on a `write({ as })`).
   */
  readonly to: number;
  /** Read outcome. Always `true` for writes — a failed write throws. */
  readonly ok: boolean;
  /** Failure reason, when `ok` is false. */
  readonly reason?: string;
  readonly migratedFrom?: number | null;
  readonly downgradedFrom?: number | null;
  readonly derivedPaths?: readonly string[];
  readonly lossyPaths?: readonly string[];
  /** Epoch milliseconds. */
  readonly ts: number;
}

/** What a devtools implementation installs at `globalThis.__SKEW_DEVTOOLS_HOOK__`. */
export interface SkewDevtoolsHook {
  emit(event: SkewTraceEvent): void;
}

/** The global property devtools implementations install themselves under. */
export const SKEW_DEVTOOLS_HOOK = '__SKEW_DEVTOOLS_HOOK__';

/**
 * Emits a trace event into the installed hook, if any. A throwing hook is
 * swallowed — observability must never break the app it observes.
 */
export function emitSkewTrace(event: SkewTraceEvent): void {
  const hook = (globalThis as Record<string, unknown>)[SKEW_DEVTOOLS_HOOK] as
    | SkewDevtoolsHook
    | undefined;
  if (!hook || typeof hook.emit !== 'function') return;
  try {
    hook.emit(event);
  } catch {
    // The hook is diagnostic machinery; its failures are its own.
  }
}
