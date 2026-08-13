import { Component } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  template: `
    <header class="host-chrome">
      <span class="badge">host app (SSR)</span>
      <nav>
        <a routerLink="/" routerLinkActive="active" [routerLinkActiveOptions]="{ exact: true }">Home</a>
        <a routerLink="/billing/invoices" routerLinkActive="active">Billing</a>
        <a routerLink="/billing/settings" routerLinkActive="active">Billing settings</a>
      </nav>
    </header>
    <main>
      <router-outlet />
    </main>
  `,
  styles: `
    :host { display: block; font-family: system-ui, sans-serif; max-width: 52rem; margin: 0 auto; padding: 1.5rem; }
    .host-chrome { display: flex; align-items: center; gap: 1rem; padding-bottom: 0.75rem; border-bottom: 2px solid #0ea5e9; margin-bottom: 1rem; }
    .badge { background: #0ea5e9; color: #fff; border-radius: 999px; padding: 0.15rem 0.6rem; font-size: 0.75rem; }
    nav { display: flex; gap: 0.75rem; }
    a { color: #0369a1; text-decoration: none; }
    a.active { font-weight: 700; text-decoration: underline; }
  `,
})
export class App {}
