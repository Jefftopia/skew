import { InjectionToken } from '@angular/core';

/**
 * The widget's data, as server state.
 *
 * A token rather than a fetch, because what POC 2 is testing is composition of *server-rendered*
 * markup — introducing a network hop here would make an SSR timing test into a test of someone
 * else's API.
 */
export interface Notification {
  id: string;
  title: string;
  at: string;
  unread: boolean;
}

export const NOTIFICATIONS = new InjectionToken<readonly Notification[]>('notifications feed', {
  providedIn: 'root',
  factory: () => [
    { id: 'n1', title: 'Invoice 4821 was paid', at: '2m', unread: true },
    { id: 'n2', title: 'Statement ready for March', at: '1h', unread: true },
    { id: 'n3', title: 'Card ending 4242 expires soon', at: '3h', unread: true },
    { id: 'n4', title: 'Welcome to the portal', at: '2d', unread: false },
  ],
});
