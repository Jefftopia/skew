import { Routes } from '@angular/router';
import { NotificationsPanel } from './notifications';
import { StandalonePage } from './standalone-page';

/**
 * `/panel` is the widget as it is embedded; `/` is the same widget with a page around it.
 *
 * The manifest's `src` names `/panel`, so the embedded shape is a route on this app rather than a
 * special mode of it — the fragment is the *content at a URL*, which is the whole idea an unbound
 * fragment expresses.
 */
export const routes: Routes = [
  { path: 'panel', component: NotificationsPanel },
  { path: '', component: StandalonePage },
];
