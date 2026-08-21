import { Component, signal } from '@angular/core';
import { BraidFragment, type BraidFragmentError, type BraidFragmentEvent } from '@braidlabs/angular';
import { DeferredPanel } from './deferred-panel';

/**
 * One Angular page composing three independently deployed applications:
 *
 * - **billing** — an Angular SPA, bound to the host router (compat adapter)
 * - **reviews** — a React 19 app (compat adapter, no adapter declared)
 * - **rating** — a framework-free custom element (contract `custom-element` adapter)
 *
 * The host imports none of them. Each runs in its own realm with its own dependency graph, so
 * Angular and React coexist on this page without sharing a thing.
 */
@Component({
  selector: 'app-billing-page',
  standalone: true,
  imports: [BraidFragment, DeferredPanel],
  template: `
    <h2>Billing</h2>
    <p class="note">
      Three fragments below, from three separately deployed applications. The host never imported
      any of them.
    </p>

    <braid-fragment name="billing" (ready)="onReady($event)" (failed)="onFailed($event)" />

    <braid-fragment name="reviews" (ready)="onReady($event)" (failed)="onFailed($event)" />

    <!--
      A web component, mounted by the contract adapter. Props go in as element properties and its
      own rating:change event comes back out as a typed host event — no emulation involved.
    -->
    <braid-fragment
      name="rating"
      [props]="{ value: rating(), label: 'How is billing working for you?' }"
      (fragmentEvent)="onRatingChange($event)"
      (failed)="onFailed($event)"
    />

    <p class="status">
      @if (ready().length) {
        ready: <strong>{{ ready().join(', ') }}</strong> ·
      }
      host received rating: <strong>{{ rating() }}</strong> / 5
      @if (failure(); as message) {
        <br /><span class="failure">{{ message }}</span>
      }
    </p>

    <!--
      Incremental hydration on the same page as three fragments: server-rendered, dehydrated
      until interaction, and independent of every realm on the page.
    -->
    @defer (hydrate on interaction) {
      <app-deferred-panel />
    } @placeholder {
      <p class="placeholder">deferred panel placeholder (should never be seen when SSR'd)</p>
    }
  `,
  styles: `
    .note { color: #475569; font-size: 0.9rem; }
    braid-fragment { display: block; margin-top: 1rem; min-height: 4rem; }
    .status { margin-top: 1rem; color: #475569; font-size: 0.85rem; }
    .failure { color: #b91c1c; }
  `,
})
export class BillingPage {
  readonly ready = signal<string[]>([]);
  readonly rating = signal(4);
  readonly failure = signal<string | undefined>(undefined);

  onReady(detail: { fragmentId: string }): void {
    this.ready.update((ids) => (ids.includes(detail.fragmentId) ? ids : [...ids, detail.fragmentId]));
  }

  onFailed(detail: BraidFragmentError): void {
    this.failure.set(`${detail.fragmentId} failed at ${detail.stage}: ${detail.fixHint ?? detail.error.message}`);
  }

  /** The web component's own event, republished across the fragment boundary. */
  onRatingChange(event: BraidFragmentEvent): void {
    const detail = event.detail as { value?: number } | undefined;
    if (typeof detail?.value === 'number') this.rating.set(detail.value);
  }
}
