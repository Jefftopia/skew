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

const MAX_SUGGESTIONS = 6;

/**
 * Ticker picker for the order form.
 *
 * A near-copy of the host's component, duplicated for the same reason
 * everything else here is: two independently built applications, neither able
 * to import from the other. Both fetch the same `/api/v1/tickers` list, so
 * they agree on the universe without sharing a line of code — the API is the
 * shared thing, not a library.
 *
 * Every ticker is selectable for every fund. Mandate eligibility is a real
 * constraint in a real system and a distraction in this one.
 */
@Component({
  selector: 'remote-ticker-typeahead',
  template: `
    <div class="ta">
      <input
        type="text"
        [value]="query()"
        placeholder="Search a ticker…"
        (input)="onInput($any($event.target).value)"
        (keydown)="onKey($event)"
        (focus)="open.set(true)"
        (blur)="open.set(false)"
        role="combobox"
        [attr.aria-expanded]="open()"
        aria-controls="rta-listbox"
        [attr.aria-activedescendant]="open() ? 'rta-opt-' + active() : null"
        aria-autocomplete="list"
      />
      @if (open() && matches().length > 0) {
        <ul class="ta-list" role="listbox" id="rta-listbox">
          @for (o of matches(); track o.ticker; let i = $index) {
            <li
              role="option"
              [id]="'rta-opt-' + i"
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
        padding: 0.45rem 0.6rem;
        border: 1px solid #d8dee9;
        border-radius: 8px;
        font: inherit;
        font-size: 0.8rem;
        box-sizing: border-box;
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
        max-height: 13rem;
        overflow-y: auto;
      }
      .ta-list li {
        display: flex;
        gap: 0.5rem;
        align-items: baseline;
        padding: 0.3rem 0.45rem;
        border-radius: 6px;
        cursor: pointer;
        font-size: 0.76rem;
      }
      .ta-list li.active,
      .ta-list li:hover {
        background: #f3ecff;
      }
      .sym {
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-weight: 700;
        color: #6b4fa0;
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

  readonly value = input('');
  readonly selected = output<string>();

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
        error: () => this.options.set([]),
      });
  }

  protected onInput(value: string): void {
    this.query.set(value);
    this.active.set(0);
    this.open.set(true);
    // Free text is a valid order too — emit as typed so the form stays usable
    // if the universe endpoint is unreachable.
    this.selected.emit(value);
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
    this.selected.emit(option.ticker);
  }
}
