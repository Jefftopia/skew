import { Component, effect, inject, signal } from '@angular/core';
import { DRAFT_KEY, DraftSchemaV1 } from './domain';
import { SharedStore, type DriverKind } from './shared-store';

/**
 * The shared store, made visible.
 *
 * The single most confusing thing about this demo used to be invisible: the
 * host and the remote are not passing data to each other at all. Neither one
 * calls the other. They both read and write **the same key in the same browser
 * store**, and everything else — the migrations, the refusals, the whole
 * argument — happens because of that one shared byte range.
 *
 * Saying so in prose did not work. This shows the actual key, the actual bytes
 * currently in it, and which of the two builds wrote them last, so the thing
 * both panes are arguing about is on screen next to them.
 *
 * The driver toggle is here for the same reason: swapping `localStorage` for
 * IndexedDB changes nothing about the versioning story, which is the point.
 * The envelope is the contract; where the bytes live is an implementation
 * detail, and being able to change it in one click is the most direct way to
 * show that.
 */
@Component({
  selector: 'host-store-panel',
  template: `
    <section class="store">
      <header>
        <div class="lede">
          <h3>The shared store</h3>
          <p>
            Neither build calls the other. They read and write this one key —
            that is the entire channel between them.
          </p>
        </div>

        <div class="driver">
          <span class="driver-label">Driver</span>
          <div class="seg" role="group" aria-label="Storage driver">
            <button
              [class.on]="store.kind() === 'local'"
              (click)="switchTo('local')"
            >
              localStorage
            </button>
            <button
              [class.on]="store.kind() === 'indexeddb'"
              (click)="switchTo('indexeddb')"
            >
              IndexedDB
            </button>
          </div>
        </div>
      </header>

      <div class="key-row">
        <span class="k">key</span>
        <code>{{ fullKey }}</code>
        <button class="refresh" (click)="refresh()">
          {{ loading() ? '…' : 'Refresh' }}
        </button>
      </div>

      @if (store.isAsync()) {
        <p class="async-note">
          IndexedDB is asynchronous, so <code>peek()</code> returns
          <code>null</code> here rather than pretending it can read
          synchronously — the reason <code>&#64;skew/core</code> separates it
          from <code>get()</code> at all.
        </p>
      }

      @if (bytes(); as b) {
        <pre>{{ b }}</pre>
        <p class="reading">
          @if (version() !== null) {
            Envelope present — written under <strong>v{{ version() }}</strong
            >. Any reader can tell what this is before parsing it.
          } @else {
            <span class="bare">No envelope.</span>
            Nothing here says which schema or build produced these bytes.
          }
        </p>
      } @else {
        <p class="empty">Nothing stored at this key yet.</p>
      }
    </section>
  `,
  styles: [
    `
      .store {
        border: 1px solid #d8dee9;
        border-radius: 14px;
        background: #fff;
        padding: 0.9rem 1.1rem 1rem;
        margin-bottom: 1rem;
      }
      header {
        display: flex;
        align-items: flex-start;
        gap: 1rem;
        flex-wrap: wrap;
      }
      .lede {
        flex: 1;
        min-width: 15rem;
      }
      h3 {
        margin: 0 0 0.15rem;
        font-size: 0.9rem;
      }
      .lede p {
        margin: 0;
        font-size: 0.76rem;
        color: #5b6779;
        line-height: 1.5;
        max-width: 52ch;
      }
      .driver {
        display: grid;
        gap: 0.25rem;
        justify-items: end;
      }
      .driver-label {
        font-size: 0.6rem;
        text-transform: uppercase;
        letter-spacing: 0.07em;
        color: #8b96a6;
        font-weight: 700;
      }
      .seg {
        display: flex;
        border: 1px solid #d8dee9;
        border-radius: 8px;
        overflow: hidden;
      }
      .seg button {
        background: #fff;
        border: 0;
        padding: 0.32rem 0.6rem;
        font-size: 0.7rem;
        font-weight: 700;
        color: #5b6779;
        cursor: pointer;
      }
      .seg button.on {
        background: #1e3a5f;
        color: #fff;
      }
      .key-row {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        margin-top: 0.8rem;
      }
      .k {
        font-size: 0.6rem;
        text-transform: uppercase;
        letter-spacing: 0.07em;
        color: #8b96a6;
        font-weight: 700;
      }
      .key-row code {
        font-size: 0.72rem;
        background: #f2f5f9;
        padding: 0.15rem 0.4rem;
        border-radius: 5px;
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .refresh {
        background: #eef2f7;
        color: #1e3a5f;
        border: 0;
        border-radius: 7px;
        padding: 0.25rem 0.55rem;
        font-size: 0.68rem;
        font-weight: 700;
        cursor: pointer;
        flex: none;
      }
      pre {
        background: #f2f5f9;
        border-radius: 8px;
        padding: 0.6rem 0.7rem;
        font-size: 0.71rem;
        overflow-x: auto;
        margin: 0.6rem 0 0.4rem;
      }
      .reading,
      .empty,
      .async-note {
        margin: 0.4rem 0 0;
        font-size: 0.74rem;
        color: #5b6779;
        line-height: 1.5;
      }
      .async-note {
        background: #eef4fb;
        border: 1px solid #cfe0f2;
        border-radius: 8px;
        padding: 0.4rem 0.6rem;
        margin-top: 0.7rem;
      }
      .bare {
        color: #7f1d1d;
        font-weight: 700;
      }
      code {
        font-size: 0.72rem;
      }
    `,
  ],
})
export class StorePanel {
  protected readonly store = inject(SharedStore);

  /** The fully-qualified key, namespaced by schema name — shown verbatim. */
  protected readonly fullKey = `${DraftSchemaV1.name}:${DRAFT_KEY}`;

  protected readonly bytes = signal<string | null>(null);
  protected readonly version = signal<number | null>(null);
  protected readonly loading = signal(false);

  constructor() {
    // Redraw the instant this build writes, or the driver changes.
    effect(() => {
      this.store.revision();
      this.store.kind();
      void this.refresh();
    });

    // And poll, more slowly, for writes made by the *remote* build — it has
    // its own copy of the store module and no way to signal into this one.
    setInterval(() => void this.refresh(), 1200);
  }

  protected async switchTo(kind: DriverKind): Promise<void> {
    this.store.setKind(kind);
    await this.refresh();
  }

  protected async refresh(): Promise<void> {
    this.loading.set(true);
    try {
      const raw = await this.store.rawAt(this.fullKey);
      if (!raw) {
        this.bytes.set(null);
        this.version.set(null);
        return;
      }
      const parsed: unknown = JSON.parse(raw);
      this.bytes.set(JSON.stringify(parsed, null, 2));
      const v = (parsed as { v?: unknown })?.v;
      this.version.set(typeof v === 'number' ? v : null);
    } catch {
      this.bytes.set(null);
      this.version.set(null);
    } finally {
      this.loading.set(false);
    }
  }
}
