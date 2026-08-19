import { Component, input } from '@angular/core';

/**
 * A demo panel: one claim, one control, one visible proof.
 *
 * The rule this encodes is that **the evidence lives in the panel**. "Open devtools and look at the
 * network tab" is homework, not a demonstration — so if the proof is a request count, the panel
 * shows the number.
 *
 * Deliberately plain. Every minute spent styling this is a minute not spent making a claim
 * provable, and a panel that needs decoration to be interesting is a panel whose claim is weak.
 */
@Component({
  selector: 'demo-panel',
  standalone: true,
  template: `
    <section class="panel">
      <header>
        <span class="n">{{ n() }}</span>
        <div>
          <h3>{{ claim() }}</h3>
          @if (proves()) {
            <p class="proves">Proves: {{ proves() }}</p>
          }
        </div>
      </header>

      <div class="body">
        <ng-content />
      </div>
    </section>
  `,
  styles: `
    :host { display: block; }
    .panel { border: 1px solid #d5dae1; border-radius: 8px; background: #fff; margin-bottom: 0.9rem; }
    header { display: flex; gap: 0.7rem; padding: 0.7rem 0.85rem; border-bottom: 1px solid #eef1f4; }
    .n {
      flex: none; width: 1.5rem; height: 1.5rem; border-radius: 999px; background: #0ea5e9; color: #fff;
      display: grid; place-items: center; font-size: 0.78rem; font-weight: 700;
    }
    h3 { margin: 0; font-size: 0.98rem; font-weight: 600; line-height: 1.35; }
    .proves { margin: 0.15rem 0 0; font-size: 0.78rem; color: #64748b; }
    .body { padding: 0.85rem; display: flex; flex-direction: column; gap: 0.6rem; }
  `,
})
export class DemoPanel {
  readonly n = input.required<number>();
  /** The claim, in a sentence a visitor can check. Not a feature name. */
  readonly claim = input.required<string>();
  /** The property being demonstrated, named plainly. */
  readonly proves = input<string>('');
}
