/**
 * The remote's end of the shared trace.
 *
 * The host owns the trace panel, and the host is a different build — this app
 * cannot import its `Lab` service any more than it can import its types. So the
 * two agree on a medium instead: a `sessionStorage` key and a DOM event, both
 * plain strings, neither one requiring either side to know the other exists.
 *
 * That is the same bargain as `domain.ts`. The duplication is the price of
 * independent deployability, and it is a low price when what crosses the
 * boundary is this small.
 *
 * Standalone, nothing is listening and the entries simply accumulate in storage
 * for whenever the host is next opened.
 */

const LOG_KEY = 'skew-demo:trace';
const EVENT = 'skew-demo:log';

export type Level = 'step' | 'ok' | 'warn' | 'fail' | 'note';

export interface LogEntry {
  readonly seq: number;
  readonly at: string;
  readonly level: Level;
  readonly scenario: string;
  readonly message: string;
  readonly protected: boolean;
}

export function trace(
  level: Level,
  scenario: string,
  message: string,
  guarded: boolean,
): void {
  const entry: LogEntry = {
    seq: Date.now(),
    at: new Date().toISOString().slice(11, 23),
    level,
    scenario,
    message,
    protected: guarded,
  };

  try {
    const raw = globalThis.sessionStorage?.getItem(LOG_KEY);
    const all = raw ? (JSON.parse(raw) as LogEntry[]) : [];
    globalThis.sessionStorage?.setItem(
      LOG_KEY,
      JSON.stringify([...all, entry].slice(-200)),
    );
  } catch {
    /* private mode — the trace just won't persist */
  }

  // The host appends this without re-reading storage, so the panel updates
  // while the remote is running inside it.
  globalThis.dispatchEvent?.(new CustomEvent(EVENT, { detail: entry }));
}
