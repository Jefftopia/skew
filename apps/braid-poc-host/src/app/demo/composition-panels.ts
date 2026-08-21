import { Component, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { BraidFragment } from '@braidlabs/angular';
import { DemoPanel } from './panel';

/**
 * Act one — composition. Everything here works today.
 *
 * These panels claim things about *boundaries*: what each app can see, what it cannot, and what
 * crosses deliberately.
 */
@Component({
  selector: 'demo-composition',
  standalone: true,
  imports: [DemoPanel, BraidFragment, FormsModule],
  template: `
    <h2>Composition</h2>

    <demo-panel
      [n]="1"
      claim="Three apps are on this page. None of them imported the others."
      proves="Independent deployment — each app is built, versioned, and served separately"
    >
      <p class="hint">
        Each strip below is rendered by a different application, and each one reports the technology
        it is running <em>from inside its own realm</em>. The host did not tell it what to say.
      </p>
      <div class="who">
        <span class="tag host">host · Angular {{ hostAngular }} · SSR</span>
        <braid-fragment name="reviews" src="/demo" />
        <braid-fragment name="live-text" src="/demo" [props]="{ text: 'a third app, no framework' }" />
      </div>
      <p class="hint">
        The Angular <em>billing</em> remote is a fourth, shown on the Billing page — left off this
        page deliberately; see the note at the bottom.
      </p>
    </demo-panel>

    <demo-panel
      [n]="2"
      claim="Type here. It appears in the other app as you type."
      proves="Cross-realm reactive state — nothing leaves the page, and no shared JavaScript"
    >
      <label class="row">
        <span>Host input</span>
        <input
          [ngModel]="typed()"
          (ngModelChange)="publish($event)"
          placeholder="type anything…"
          aria-label="Live typing source"
        />
      </label>
      <p class="hint">
        This is not a network feature. The value crosses into another JavaScript context as a prop,
        structured-cloned at the boundary — the two apps share no memory and nothing leaves the page.
      </p>
      <braid-fragment name="live-text" src="/demo" [props]="{ text: typed() }" />
    </demo-panel>

    <demo-panel
      [n]="3"
      claim="This app cannot see the other app's globals, and the page's prototypes are untouched."
      proves="Realm isolation, and Braid's host-purity invariant"
    >
      <button type="button" (click)="probe()">Check</button>
      @if (isolation(); as result) {
        <dl class="facts">
          <dt>window.React in the host</dt>
          <dd>{{ result.reactInHost }}</dd>
          <dt>star-rating defined in the host's registry</dt>
          <dd>{{ result.widgetInHost }}</dd>
          <dt>Node.prototype.appendChild</dt>
          <dd>{{ result.appendChild }}</dd>
          <dt>realms on this page</dt>
          <dd>{{ result.realms }}</dd>
        </dl>
      }
    </demo-panel>
  `,
  styles: `
    :host { display: block; }
    h2 { font-size: 1.05rem; margin: 1.4rem 0 0.6rem; }
    .hint { margin: 0; font-size: 0.82rem; color: #64748b; line-height: 1.45; }
    .who { display: flex; flex-direction: column; gap: 0.4rem; }
    .tag { display: inline-block; font-size: 0.8rem; padding: 0.2rem 0.55rem; border-radius: 999px; border: 1px solid #cbd5e1; }
    .tag.host { background: #0ea5e9; color: #fff; border-color: #0ea5e9; }
    .row { display: flex; align-items: center; gap: 0.6rem; }
    .row span { font-size: 0.82rem; color: #475569; min-width: 5.5rem; }
    input { flex: 1; padding: 0.35rem 0.5rem; border: 1px solid #cbd5e1; border-radius: 5px; font: inherit; }
    button { font: inherit; padding: 0.3rem 0.7rem; border: 1px solid #cbd5e1; border-radius: 5px; background: #f8fafc; cursor: pointer; align-self: flex-start; }
    .facts { display: grid; grid-template-columns: auto 1fr; gap: 0.2rem 0.8rem; margin: 0; font-size: 0.82rem; }
    dt { color: #64748b; }
    dd { margin: 0; font-family: ui-monospace, monospace; }
  `,
})
export class DemoComposition {
  readonly hostAngular = '22';
  readonly typed = signal('');
  readonly isolation = signal<{
    reactInHost: string;
    widgetInHost: string;
    appendChild: string;
    realms: number;
  } | null>(null);

  /**
   * Panel 2's mechanism: a prop, delivered across the realm boundary.
   *
   * Structured-cloned on the way out, so the two apps never share an object — which is what keeps
   * a fragment's lifetime independent of the host's.
   *
   * Props reach a fragment through `env`, which the *contract* adapters supply. A compat-mode
   * fragment has no equivalent channel today, so this panel uses a custom element rather than the
   * Angular remote.
   */
  publish(value: string): void {
    this.typed.set(value);
  }

  probe(): void {
    this.isolation.set({
      reactInHost: String((globalThis as Record<string, unknown>)['React']),
      widgetInHost: String(customElements.get('star-rating') !== undefined),
      appendChild: Node.prototype.appendChild.toString().includes('[native code]')
        ? 'native (unpatched)'
        : 'PATCHED — invariant broken',
      realms: document.querySelectorAll('iframe[name^="braid:"]').length,
    });
  }
}
