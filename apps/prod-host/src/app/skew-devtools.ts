import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  computed,
  signal,
} from '@angular/core';
import type { SkewTraceEvent } from '@skew/core';
import { installSkewDevtoolsHook } from '../skew-devtools-hook';

/**
 * The skew devtools drawer: a live feed of every `read()` / `write()` on the
 * page, from BOTH builds — the hook is installed once in `main.ts` and the
 * host and remote share one `@skew/core` instance via `sharedMappings`.
 *
 * Events carry versions, outcomes, and paths — never payloads; that is the
 * library's privacy default, and this panel inherits it. Watch it while
 * running any scenario: a v1→v2 migration shows as ↑, a registry- or
 * contract-cured read of newer data as ↓ with its lossy paths, a refusal as
 * the reason (`ahead`, `retired`, …) the application code saw.
 */
@Component({
  selector: 'host-skew-devtools',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <details class="devtools">
      <summary>
        Skew devtools — live schema activity
        <span class="count">{{ events().length }}</span>
        @if (lastReason(); as reason) {
          <span class="last-bad">last failure: {{ reason }}</span>
        }
      </summary>
      <div class="toolbar">
        <span
          >One row per <code>read()</code>/<code>write()</code>, both builds,
          newest first. Versions and outcomes only — payloads are never
          captured.</span
        >
        <label class="quiet-toggle">
          <input
            type="checkbox"
            [checked]="eventfulOnly()"
            (change)="eventfulOnly.set($any($event.target).checked)"
          />
          only eventful
        </label>
        <button (click)="clear()">Clear</button>
      </div>
      <table>
        <thead>
          <tr>
            <th>time</th>
            <th>op</th>
            <th>schema</th>
            <th>versions</th>
            <th>outcome</th>
          </tr>
        </thead>
        <tbody>
          @for (event of rows(); track event.ts + event.schema + $index) {
            <tr [class.bad]="!event.ok">
              <td>{{ time(event.ts) }}</td>
              <td>{{ event.kind }}</td>
              <td>
                <code>{{ event.schema }}</code>
              </td>
              <td>v{{ event.from }} → v{{ event.to }}</td>
              <td>
                @if (!event.ok) {
                  <strong>{{ event.reason }}</strong>
                } @else if (event.migratedFrom !== null) {
                  ↑ migrated from v{{ event.migratedFrom
                  }}{{ paths('derived', event.derivedPaths) }}
                } @else if (event.downgradedFrom !== null) {
                  ↓ downgraded from v{{ event.downgradedFrom
                  }}{{ paths('lost', event.lossyPaths) }}
                } @else {
                  current
                }
              </td>
            </tr>
          } @empty {
            <tr>
              <td colspan="5" class="empty">
                No schema activity yet — run any scenario.
              </td>
            </tr>
          }
        </tbody>
      </table>
    </details>
  `,
  styles: `
    .devtools {
      margin: 0.75rem 0;
      border: 1px solid #2c3e50;
      border-radius: 6px;
      background: #10151b;
      color: #cfd8e3;
      font-size: 0.8rem;
    }
    summary {
      cursor: pointer;
      padding: 0.5rem 0.75rem;
      font-weight: 600;
    }
    .count {
      display: inline-block;
      min-width: 1.5em;
      margin-left: 0.5em;
      padding: 0 0.4em;
      border-radius: 999px;
      background: #2c3e50;
      text-align: center;
    }
    .last-bad {
      margin-left: 0.75em;
      color: #f2a55c;
      font-weight: 400;
    }
    .toolbar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 1rem;
      padding: 0.25rem 0.75rem 0.5rem;
      color: #8ba0b6;
    }
    .quiet-toggle {
      display: inline-flex;
      align-items: center;
      gap: 0.35rem;
      white-space: nowrap;
      cursor: pointer;
    }
    table {
      width: 100%;
      border-collapse: collapse;
    }
    th,
    td {
      padding: 0.25rem 0.75rem;
      text-align: left;
      border-top: 1px solid #1d2833;
      font-variant-numeric: tabular-nums;
    }
    tr.bad td {
      color: #f2a55c;
    }
    .empty {
      color: #66788c;
      font-style: italic;
    }
    button {
      border: 1px solid #2c3e50;
      background: transparent;
      color: inherit;
      border-radius: 4px;
      padding: 0.15rem 0.6rem;
      cursor: pointer;
    }
  `,
})
export class SkewDevtools implements OnDestroy {
  private readonly hook = installSkewDevtoolsHook();
  protected readonly events = signal<readonly SkewTraceEvent[]>([
    ...this.hook.events,
  ]);
  private readonly unsubscribe = this.hook.subscribe(() =>
    this.events.set([...this.hook.events]),
  );

  /**
   * Filters out reads that neither migrated nor failed. The live tickers
   * produce one uneventful read per second, which would bury the rows this
   * panel exists to show; writes always stay, because a write is an act.
   */
  protected readonly eventfulOnly = signal(true);

  /** Newest first — the row you caused is the row you see. */
  protected readonly rows = computed(() => {
    const all = [...this.events()].reverse();
    if (!this.eventfulOnly()) return all;
    return all.filter(
      (event) =>
        !event.ok ||
        event.kind === 'write' ||
        event.migratedFrom !== null ||
        event.downgradedFrom !== null,
    );
  });

  protected readonly lastReason = computed(() => {
    const failures = this.events().filter((event) => !event.ok);
    return failures.length ? failures[failures.length - 1]?.reason : null;
  });

  protected time(ts: number): string {
    return new Date(ts).toLocaleTimeString(undefined, { hour12: false });
  }

  protected paths(label: string, list?: readonly string[]): string {
    return list && list.length ? ` (${label}: ${list.join(', ')})` : '';
  }

  protected clear(): void {
    this.hook.clear();
  }

  ngOnDestroy(): void {
    this.unsubscribe();
  }
}
