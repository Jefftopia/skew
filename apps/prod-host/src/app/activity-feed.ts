import { Component, computed, inject } from '@angular/core';
import { Lab, type Level } from './lab';

const ICON: Record<Level, string> = {
  step: '·',
  ok: '✓',
  warn: '!',
  fail: '✕',
  note: '☰',
};

/**
 * A collapsed record of what happened, for when you want it.
 *
 * This replaced a monospace terminal panel that sat open at the top of every
 * page. The information was fine; the framing was wrong — a scrolling wall of
 * `[13:35:29.454] read consumer threw:` asks the reader to be a developer
 * tailing logs, when the thing being explained is a *concept*. The Boundary
 * Inspector now carries that job visually.
 *
 * This stays, closed, because "show me literally everything in order" is a
 * real need when something misbehaves — it just should not be the first thing
 * anyone sees.
 */
@Component({
  selector: 'host-activity-feed',
  template: `
    <details class="activity">
      <summary>
        Activity
        @if (entries().length) {
          <span class="count">{{ entries().length }}</span>
        }
        @if (failures()) {
          <span class="count bad">{{ failures() }} failed</span>
        }
      </summary>

      @if (entries().length === 0) {
        <p class="empty">Nothing yet.</p>
      } @else {
        <ul>
          @for (e of reversed(); track e.seq) {
            <li [class]="e.level">
              <span class="icon">{{ icon(e.level) }}</span>
              <span class="scope">{{ e.scenario }}</span>
              <span class="msg">{{ e.message }}</span>
              <span class="at">{{ e.at.slice(0, 8) }}</span>
            </li>
          }
        </ul>
        <button class="clear" (click)="lab.clear()">Clear</button>
      }
    </details>
  `,
  styles: [
    `
      .activity {
        border: 1px solid #e2e8f0;
        border-radius: 10px;
        background: #fff;
        margin-bottom: 1.1rem;
        font-size: 0.78rem;
      }
      summary {
        cursor: pointer;
        padding: 0.5rem 0.85rem;
        color: #5b6779;
        font-weight: 700;
        font-size: 0.74rem;
        user-select: none;
        display: flex;
        align-items: center;
        gap: 0.45rem;
      }
      summary:hover {
        color: #1e3a5f;
      }
      .count {
        background: #eef2f7;
        color: #5b6779;
        border-radius: 999px;
        padding: 0.05rem 0.45rem;
        font-size: 0.66rem;
      }
      .count.bad {
        background: #fdecec;
        color: #7f1d1d;
      }
      ul {
        list-style: none;
        margin: 0;
        padding: 0 0 0.3rem;
        max-height: 260px;
        overflow-y: auto;
        border-top: 1px solid #eef2f7;
      }
      li {
        display: grid;
        grid-template-columns: 1.1rem 7rem 1fr auto;
        gap: 0.5rem;
        align-items: baseline;
        padding: 0.3rem 0.85rem;
        line-height: 1.45;
      }
      li + li {
        border-top: 1px solid #f6f8fb;
      }
      .icon {
        text-align: center;
        font-weight: 700;
        color: #9aa8bb;
      }
      li.ok .icon {
        color: #2ea043;
      }
      li.warn .icon {
        color: #b45309;
      }
      li.fail .icon {
        color: #b91c1c;
      }
      .scope {
        color: #8b96a6;
        font-size: 0.7rem;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .msg {
        color: #16202e;
        min-width: 0;
      }
      .at {
        color: #b6c0cc;
        font-size: 0.66rem;
        font-variant-numeric: tabular-nums;
      }
      .empty {
        margin: 0;
        padding: 0.7rem 0.85rem;
        color: #8b96a6;
        border-top: 1px solid #eef2f7;
      }
      .clear {
        margin: 0.2rem 0.85rem 0.7rem;
        background: #eef2f7;
        color: #1e3a5f;
        border: 0;
        border-radius: 7px;
        padding: 0.25rem 0.6rem;
        font-size: 0.68rem;
        font-weight: 700;
        cursor: pointer;
      }
      @media (max-width: 640px) {
        li {
          grid-template-columns: 1.1rem 1fr;
        }
        .scope,
        .at {
          display: none;
        }
      }
    `,
  ],
})
export class ActivityFeed {
  protected readonly lab = inject(Lab);
  protected readonly entries = this.lab.log;

  protected readonly reversed = computed(() => [...this.entries()].reverse());
  protected readonly failures = computed(
    () => this.entries().filter((e) => e.level === 'fail').length,
  );

  protected icon(level: Level): string {
    return ICON[level];
  }
}
