import { Component, inject, signal } from '@angular/core';
import { NOTIFICATIONS, type Notification } from './feed';
import { RecentActivity } from './recent-activity';

/**
 * The panel itself — a list rendered from server state.
 *
 * Meaningfully server-rendered on purpose: the point of POC 2 is that a `curl` of the *host* shows
 * these rows already in the HTML, so the markup has to be something only the server could have
 * produced. An app shell that fills itself in on the client would prove nothing.
 */
@Component({
  selector: 'notifications-panel',
  standalone: true,
  imports: [RecentActivity],
  template: `
    <div class="panel">
      <button type="button" class="summary" (click)="open.set(!open())" [attr.aria-expanded]="open()">
        <span class="count">{{ unread() }}</span>
        unread
      </button>

      @if (open()) {
        <ul class="items">
          @for (item of items; track item.id) {
            <li [class.unread]="item.unread">
              <span class="title">{{ item.title }}</span>
              <span class="at">{{ item.at }}</span>
            </li>
          }
        </ul>

        @defer (hydrate on interaction) {
          <notifications-recent-activity />
        } @placeholder {
          <p class="deferred">older activity</p>
        }
      }
    </div>
  `,
  styles: `
    .panel { border: 1px solid #cbd5e1; border-radius: 8px; background: #fff; min-width: 12rem; }
    .summary { display: flex; align-items: center; gap: 0.4rem; width: 100%; padding: 0.35rem 0.6rem; font: inherit; background: none; border: 0; cursor: pointer; }
    .count { background: #dc2626; color: #fff; border-radius: 999px; min-width: 1.3rem; padding: 0 0.35rem; text-align: center; font-weight: 600; }
    .items { list-style: none; margin: 0; padding: 0.2rem 0; border-top: 1px solid #e2e8f0; max-height: 14rem; overflow-y: auto; }
    li { display: flex; justify-content: space-between; gap: 0.75rem; padding: 0.3rem 0.6rem; }
    li.unread .title { font-weight: 600; }
    .at { color: #64748b; font-size: 0.75rem; white-space: nowrap; }
    .deferred { margin: 0; padding: 0.3rem 0.6rem; font-size: 0.75rem; color: #92400e; }
  `,
})
export class NotificationsPanel {
  /** Resolved on the server for a server render, so the rows arrive in the HTML. */
  readonly items: readonly Notification[] = inject(NOTIFICATIONS);
  readonly open = signal(true);

  unread(): number {
    return this.items.filter((item) => item.unread).length;
  }
}
