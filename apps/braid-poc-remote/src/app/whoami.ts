import { Component, VERSION } from '@angular/core';

/**
 * Reports which application and framework this is, from inside its own realm.
 *
 * The host does not tell it what to say. It reads its own `VERSION`, from its own copy of Angular,
 * loaded through its own namespace — which is the claim panel 1 is making.
 */
@Component({
  selector: 'billing-whoami',
  standalone: true,
  template: `
    <span class="tag">
      billing (remote) · Angular {{ version }}
      <em>own realm, own bundle</em>
    </span>
  `,
  styles: `
    :host { display: block; }
    .tag {
      display: inline-flex; align-items: baseline; gap: 0.5rem; font-family: system-ui, sans-serif;
      font-size: 0.8rem; padding: 0.2rem 0.55rem; border-radius: 999px;
      background: #7c3aed; color: #fff;
    }
    em { font-style: normal; opacity: 0.75; font-size: 0.72rem; }
  `,
})
export class WhoAmI {
  readonly version = VERSION.major;
}
