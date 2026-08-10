import { Injectable, computed, effect, signal } from '@angular/core';
import { isSkewDisabled, setSkewDisabled } from '@skew/core';

/**
 * The demo's instrumentation: a protection switch and an event log.
 *
 * Both exist for the same reason. A demo that only ever shows the protected
 * path asks you to take on faith that the unprotected one is worse, and a demo
 * that narrates its reasoning in prose asks you to take on faith that the code
 * does what the prose says. So: flip the protections off and run the same
 * scenario, and have every step write down what it did as it happens.
 */

export type Level = 'step' | 'ok' | 'warn' | 'fail' | 'note';

export interface LogEntry {
  readonly seq: number;
  readonly at: string;
  readonly level: Level;
  readonly scenario: string;
  readonly message: string;
  /** Protections on or off when this happened — the log outlives the toggle. */
  readonly protected: boolean;
}

/**
 * The trace is kept in `sessionStorage`, deliberately by hand.
 *
 * Two reasons. It has to survive a reload, because the most interesting thing
 * the unprotected path does *is* reload — and a trace that resets on the thing
 * it is trying to document is useless. And it must not go through
 * `createVersionedStore`, because the switch being demonstrated would then
 * change how the demo's own instrumentation behaves. Instruments stay outside
 * the experiment.
 */
const LOG_KEY = 'skew-demo:trace';
const MODE_KEY = 'skew-demo:protections-off';

/**
 * The chosen mode, read before Angular starts.
 *
 * Scenario 4's unprotected path reloads the page, and a mode that reset on
 * reload would flip the protections back on mid-scenario — landing you in the
 * protected build to observe the unprotected one. `app.config.ts` feeds this to
 * `provideSkewDisabled()` so the flag is right before the first read happens.
 */
export function protectionsDisabledAtBoot(): boolean {
  try {
    return globalThis.sessionStorage?.getItem(MODE_KEY) === 'true';
  } catch {
    return false;
  }
}

function saveMode(off: boolean): void {
  try {
    if (off) globalThis.sessionStorage?.setItem(MODE_KEY, 'true');
    else globalThis.sessionStorage?.removeItem(MODE_KEY);
  } catch {
    /* ignore */
  }
}

function loadLog(): readonly LogEntry[] {
  try {
    const raw = globalThis.sessionStorage?.getItem(LOG_KEY);
    return raw ? (JSON.parse(raw) as LogEntry[]) : [];
  } catch {
    return [];
  }
}

function saveLog(entries: readonly LogEntry[]): void {
  try {
    globalThis.sessionStorage?.setItem(
      LOG_KEY,
      JSON.stringify(entries.slice(-200)),
    );
  } catch {
    /* private mode — the demo still runs, the trace just won't survive a reload */
  }
}

@Injectable({ providedIn: 'root' })
export class Lab {
  private readonly entries = signal<readonly LogEntry[]>(loadLog());
  private seq = this.entries().reduce((max, e) => Math.max(max, e.seq), 0);

  /**
   * Mirrors the flag in `@skew/core` rather than owning it.
   *
   * The flag itself is module-level state inside core — there is no injector
   * there to hold it — so this signal is a view onto it, and `toggle()` writes
   * through. Reading `isSkewDisabled()` at construction keeps the two in step
   * when something else (a `provideSkewDisabled()` at bootstrap) set it first.
   */
  private readonly protectionsOff = signal(isSkewDisabled());

  readonly guarded = computed(() => !this.protectionsOff());
  readonly log = this.entries.asReadonly();

  constructor() {
    effect(() => {
      const off = this.protectionsOff();
      setSkewDisabled(off);
      saveMode(off);
    });

    /**
     * The remote's end of the trace.
     *
     * It is a separately built application and cannot import this service, so
     * it dispatches a DOM event carrying an entry of the same shape. A string
     * event name and a plain object are the entire contract — which is the
     * point being made everywhere else in this demo, applied to the
     * instrumentation itself.
     */
    globalThis.addEventListener?.('skew-demo:log', (event) => {
      const entry = (event as CustomEvent<LogEntry>).detail;
      if (!entry?.message) return;
      this.entries.update((all) => [...all, { ...entry, seq: ++this.seq }]);
    });
  }

  toggle(): void {
    const next = !this.protectionsOff();
    this.protectionsOff.set(next);
    this.clear();
    this.write(
      'note',
      'mode',
      next
        ? 'Protections OFF — @skew is inert. Envelopes, migrations, retries and recovery all stand down.'
        : 'Protections ON — every boundary is checked.',
    );
  }

  write(level: Level, scenario: string, message: string): void {
    const at = new Date().toISOString().slice(11, 23);
    this.entries.update((all) => {
      const next = [
        ...all,
        {
          seq: ++this.seq,
          at,
          level,
          scenario,
          message,
          protected: this.guarded(),
        },
      ];
      saveLog(next);
      return next;
    });
  }

  clear(): void {
    this.entries.set([]);
    saveLog([]);
  }
}
