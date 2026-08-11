import { Directive, ElementRef, effect, inject, input } from '@angular/core';
import { Tour } from './tour';

/**
 * Marks an element as spotlightable: `<nav tourAnchor="tabs">`.
 *
 * A directive rather than the obvious `document.querySelector('.tabs')`,
 * because the tour's targets move. The remote pane appears when a fetch
 * resolves, the portfolio cards only exist on their route, and CSS class
 * names get renamed by whoever is restyling that week. A registered anchor
 * either exists or does not, the tour can see which, and a rename breaks the
 * build instead of quietly spotlighting nothing.
 */
@Directive({ selector: '[hostTourAnchor]' })
export class TourAnchor {
  readonly hostTourAnchor = input.required<string>();

  private readonly el = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly tour = inject(Tour);

  constructor() {
    effect((onCleanup) => {
      const id = this.hostTourAnchor();
      const node = this.el.nativeElement;
      this.tour.registerAnchor(id, node);
      onCleanup(() => this.tour.unregisterAnchor(id, node));
    });
  }
}
