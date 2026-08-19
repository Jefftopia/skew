import { Component } from '@angular/core';
import { NotificationsPanel } from './notifications';

/** Proof the remote is a real application: the same panel, served on its own origin. */
@Component({
  selector: 'notifications-standalone',
  standalone: true,
  imports: [NotificationsPanel],
  template: `
    <main>
      <h1>Notifications</h1>
      <p>This app is deployed on its own. The host embeds the panel below from <code>/panel</code>.</p>
      <notifications-panel />
    </main>
  `,
  styles: `
    main { max-width: 32rem; margin: 3rem auto; padding: 0 1rem; }
    h1 { font-size: 1.3rem; }
    p { color: #475569; }
  `,
})
export class StandalonePage {}
