import {
  Component,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { API_BASE } from './contracts';

export interface TickerOption {
  readonly ticker: string;
  readonly name: string;
}

const MAX_SUGGESTIONS = 7;

/**
 * Typeahead over the tradeable universe.
 *
 * Every ticker is offered regardless of which fund is in context — see the
 * note on the API's `tickers.controller.ts`. Eligibility rules would be
 * realistic and would bury the part of this demo that actually teaches
 * something.
 *
 * Keyboard handling is not optional here: a picker you can only drive with a
 * mouse is a picker traders will not use, and "it has a dropdown" is not the
 * same as "it works".
 */
@Component({
  selector: 'host-ticker-typeahead',
  template: `
    <div class="ta">
      <input
        type="text"
        [value]="query()"
        [placeholder]="placeholder()"
        (input)="onInput($any($event.target).value)"
        (keydown)="onKey($event)"
        (focus)="openList()"
        (blur)="onBlur()"
        role="combobox"
        [attr.aria-expanded]="open()"
        aria-controls="ta-listbox"
        [attr.aria-activedescendant]="open() ? 'ta-opt-' + active() : null"
        aria-autocomplete="list"
      />
      @if (query()) {
        <button
          class="ta-clear"
          (mousedown)="$event.preventDefault()"
          (click)="clear()"
          aria-label="Clear"
        >
          ×
        </button>
      }

      @if (open() && matches().length > 0) {
        <ul class="ta-list" role="listbox" id="ta-listbox">
          @for (o of matches(); track o.ticker; let i = $index) {
            <li
              role="option"
              [id]="'ta-opt-' + i"
              tabindex="-1"
              [attr.aria-selected]="i === active()"
              [class.active]="i === active()"
              (mousedown)="$event.preventDefault()"
              (keydown.enter)="choose(o)"
              (click)="choose(o)"
            >
              <span class="sym">{{ o.ticker }}</span>
              <span class="nm">{{ o.name }}</span>
            </li>
          }
        </ul>
      } @else if (open() && query().length > 0) {
        <ul class="ta-list">
          <li class="none">No ticker matches “{{ query() }}”</li>
        </ul>
      }
    </div>
  `,
  styles: [
    `
      .ta {
        position: relative;
      }
      input {
        width: 100%;
        padding: 0.45rem 1.6rem 0.45rem 0.6rem;
        border: 1px solid #d8dee9;
        border-radius: 8px;
        font: inherit;
        font-size: 0.8rem;
        box-sizing: border-box;
      }
      input:focus {
        outline: 2px solid #b6c6da;
        outline-offset: -1px;
      }
      .ta-clear {
        position: absolute;
        right: 0.3rem;
        top: 50%;
        transform: translateY(-50%);
        background: transparent;
        border: 0;
        color: #8b96a6;
        font-size: 0.95rem;
        cursor: pointer;
        padding: 0 0.25rem;
      }
      .ta-list {
        position: absolute;
        z-index: 40;
        top: calc(100% + 2px);
        left: 0;
        right: 0;
        margin: 0;
        padding: 0.2rem;
        list-style: none;
        background: #fff;
        border: 1px solid #d8dee9;
        border-radius: 9px;
        box-shadow: 0 10px 26px rgba(16, 24, 40, 0.14);
        max-height: 15rem;
        overflow-y: auto;
      }
      .ta-list li {
        display: flex;
        gap: 0.55rem;
        align-items: baseline;
        padding: 0.35rem 0.5rem;
        border-radius: 6px;
        cursor: pointer;
        font-size: 0.78rem;
      }
      .ta-list li.active,
      .ta-list li:hover {
        background: #eef4fb;
      }
      .ta-list li.none {
        color: #8b96a6;
        cursor: default;
      }
      .ta-list li.none:hover {
        background: transparent;
      }
      .sym {
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-weight: 700;
        color: #1e3a5f;
        flex: none;
      }
      .nm {
        color: #5b6779;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
    `,
  ],
})
export class TickerTypeahead {
  private readonly http = inject(HttpClient);

  readonly placeholder = input('Search a ticker…');
  readonly selected = output<TickerOption>();
  readonly cleared = output<void>();

  protected readonly query = signal('');
  protected readonly open = signal(false);
  protected readonly active = signal(0);
  private readonly options = signal<TickerOption[]>([]);

  protected readonly matches = computed(() => {
    const q = this.query().trim().toLowerCase();
    const all = this.options();
    const pool = q
      ? all.filter(
          (o) =>
            o.ticker.toLowerCase().includes(q) ||
            o.name.toLowerCase().includes(q),
        )
      : all;
    return pool.slice(0, MAX_SUGGESTIONS);
  });

  constructor() {
    this.http
      .get<{ v: number; payload: TickerOption[] }>(`${API_BASE}/v1/tickers`)
      .subscribe({
        next: (body) => this.options.set(body.payload ?? []),
        // Reference data, not a versioned contract — if it can't be fetched the
        // typeahead simply has nothing to offer, which is a survivable state.
        error: () => this.options.set([]),
      });
  }

  protected onInput(value: string): void {
    this.query.set(value);
    this.active.set(0);
    this.open.set(true);
  }

  protected openList(): void {
    this.open.set(true);
  }

  protected onBlur(): void {
    this.open.set(false);
  }

  protected onKey(event: KeyboardEvent): void {
    const list = this.matches();
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      this.open.set(true);
      this.active.update((i) => Math.min(i + 1, list.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      this.active.update((i) => Math.max(i - 1, 0));
    } else if (event.key === 'Enter') {
      const choice = list[this.active()];
      if (choice) {
        event.preventDefault();
        this.choose(choice);
      }
    } else if (event.key === 'Escape') {
      this.open.set(false);
    }
  }

  protected choose(option: TickerOption): void {
    this.query.set(option.ticker);
    this.open.set(false);
    this.selected.emit(option);
  }

  protected clear(): void {
    this.query.set('');
    this.open.set(false);
    this.cleared.emit();
  }
}
