import { Component } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';

/**
 * The remote application's root component.
 *
 * Note what is *not* here: no Braid import, no adapter, no awareness of being embedded. It uses
 * `routerLink` exactly as it would standalone — and because the compat adapter binds the
 * fragment's history to the host page's, those links drive the host URL too.
 */
@Component({
  selector: 'billing-root',
  standalone: true,
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  template: `
    <section class="remote">
      <header>
        <span class="badge">remote app</span>
        <nav>
          <a routerLink="/billing/invoices" routerLinkActive="active">Invoices</a>
          <a routerLink="/billing/settings" routerLinkActive="active">Settings</a>
        </nav>
      </header>
      <router-outlet />
    </section>
  `,
  styles: `
    .remote { border: 2px dashed #8b5cf6; border-radius: 10px; padding: 1rem; background: #faf5ff; }
    header { display: flex; align-items: center; gap: 1rem; margin-bottom: 0.75rem; }
    .badge { background: #8b5cf6; color: #fff; border-radius: 999px; padding: 0.15rem 0.6rem; font-size: 0.75rem; }
    nav { display: flex; gap: 0.75rem; }
    a { color: #6d28d9; text-decoration: none; }
    a.active { font-weight: 700; text-decoration: underline; }
  `,
})
export class App {}
