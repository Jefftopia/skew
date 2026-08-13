import { Component, signal } from '@angular/core';
import { BraidFragment, type BraidFragmentError } from '@skewkit/braid-angular';
import { DeferredPanel } from './deferred-panel';

/**
 * The host's billing page. Its entire contribution is the fragment: the content inside it is
 * served by a different application, deployed on its own schedule, running in its own realm.
 *
 * `<braid-fragment>` is the Angular binding over `<fragment-slot>`. Using it rather than the raw
 * custom element means this component keeps strict template checking (no
 * `CUSTOM_ELEMENTS_SCHEMA`), and gets typed outputs instead of hand-wired event listeners.
 *
 * There is no `src`, so the fragment is *bound*: it follows the host's location, and navigations
 * it performs drive the host URL.
 */
@Component({
  selector: 'app-billing-page',
  standalone: true,
  imports: [BraidFragment, DeferredPanel],
  template: `
    <h2>Billing</h2>
    <p class="note">
      Everything inside the dashed border below comes from the remote application through the
      Braid gateway. The host never imported it.
    </p>

    <braid-fragment name="billing" (ready)="onReady($event)" (failed)="onFailed($event)" />

    @if (status(); as message) {
      <p class="status">{{ message }}</p>
    }

    <!--
      Incremental hydration on the same page as a fragment. The block is server-rendered, its
      JavaScript stays undownloaded until the user interacts with it, and the fragment beside it
      boots independently of either.
    -->
    @defer (hydrate on interaction) {
      <app-deferred-panel />
    } @placeholder {
      <p class="placeholder">deferred panel placeholder (should never be seen when SSR'd)</p>
    }
  `,
  styles: `
    .note { color: #475569; font-size: 0.9rem; }
    braid-fragment { display: block; margin-top: 1rem; min-height: 8rem; }
    .status { color: #475569; font-size: 0.8rem; font-style: italic; }
  `,
})
export class BillingPage {
  readonly status = signal<string | undefined>(undefined);

  onReady(detail: { fragmentId: string }): void {
    this.status.set(`fragment "${detail.fragmentId}" reported ready through the Angular binding`);
  }

  onFailed(detail: BraidFragmentError): void {
    this.status.set(`fragment failed at ${detail.stage}: ${detail.fixHint ?? detail.error.message}`);
  }
}
