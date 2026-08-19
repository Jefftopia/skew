import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';

/**
 * The remote's own root.
 *
 * It has a router because it is a real application that can be opened on its own at
 * <http://localhost:4504/panel> — which is worth keeping true, since "deployed independently"
 * should mean it stands up without a host at all.
 */
@Component({
  selector: 'notifications-root',
  standalone: true,
  imports: [RouterOutlet],
  template: `<router-outlet />`,
})
export class App {}
