import { Component, signal } from '@angular/core';

/**
 * The contents of the widget's `@defer (hydrate on interaction)` block.
 *
 * POC 1 proved a deferred block keeps working *beside* a fragment. This one is inside one: the
 * block is server-rendered by the notifications app, pierced into the host's HTML, and stays
 * dehydrated until someone interacts with it — inside a realm, reached through the compat document
 * facade. `hydrated()` flipping is the observable proof, because before that the button is markup.
 */
@Component({
  selector: 'notifications-recent-activity',
  standalone: true,
  template: `
    <p class="state">
      block state: <strong data-testid="widget-hydration-state">{{ hydrated() ? 'hydrated' : 'dehydrated' }}</strong>
    </p>
    <button type="button" data-testid="widget-defer-button" (click)="hydrated.set(true)">Show older</button>
  `,
  styles: `
    :host { display: block; padding: 0.3rem 0.6rem; border-top: 1px dashed #f59e0b; background: #fffbeb; }
    .state { margin: 0 0 0.25rem; font-size: 0.75rem; color: #92400e; }
    button { font: inherit; font-size: 0.75rem; padding: 0.15rem 0.5rem; border: 1px solid #f59e0b; border-radius: 5px; background: #fff; cursor: pointer; }
  `,
})
export class RecentActivity {
  readonly hydrated = signal(false);
}
