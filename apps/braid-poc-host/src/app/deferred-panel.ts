import { Component, signal } from '@angular/core';

/**
 * A component rendered inside a `@defer (hydrate on interaction)` block.
 *
 * It is server-rendered like anything else, but its JavaScript is not downloaded or hydrated
 * until the user interacts with it. `hydrated()` flipping to true is the observable proof that
 * hydration happened — before that, the button is inert markup.
 */
@Component({
  selector: 'app-deferred-panel',
  standalone: true,
  template: `
    <p class="state">
      hydration state: <strong data-testid="hydration-state">{{ hydrated() ? 'hydrated' : 'dehydrated' }}</strong>
    </p>
    <button type="button" data-testid="defer-button" (click)="hydrated.set(true)">
      Click to hydrate this block
    </button>
    <p class="hint">
      This block was server-rendered, then left dehydrated until you interacted with it — on a
      page that also composes a fragment from another application.
    </p>
  `,
  styles: `
    :host { display: block; margin-top: 1.5rem; padding: 1rem; border: 2px dotted #f59e0b; border-radius: 10px; background: #fffbeb; }
    .state { margin-top: 0; }
    .hint { color: #92400e; font-size: 0.85rem; margin-bottom: 0; }
  `,
})
export class DeferredPanel {
  readonly hydrated = signal(false);
}
