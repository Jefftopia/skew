import { CUSTOM_ELEMENTS_SCHEMA, Component } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  // `<fragment-slot>` is a custom element defined by the Braid client runtime, not an Angular
  // component. Without this, the template compiler reports it as an unknown element.
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  template: `
    <header class="host-chrome">
      <span class="badge">host app (SSR)</span>
      <nav>
        <a routerLink="/" routerLinkActive="active" [routerLinkActiveOptions]="{ exact: true }">Home</a>
        <a routerLink="/billing/invoices" routerLinkActive="active">Billing</a>
        <a routerLink="/billing/settings" routerLinkActive="active">Billing settings</a>
        <a routerLink="/demo" routerLinkActive="active">What it does</a>
      </nav>

      <!--
        The notifications widget: a separately deployed, server-rendered Angular app, living in the
        shell rather than in a route. The src attribute is what makes it unbound — it says the
        fragment's content is at /panel on its own origin, whatever page the user is on, and it
        works the same whether the gateway pierced this response or the client booted the fragment.
      -->
      <fragment-slot name="notifications" src="/panel" class="notifications"></fragment-slot>
    </header>
    <main>
      <router-outlet />
    </main>
  `,
  styles: `
    :host { display: block; font-family: system-ui, sans-serif; max-width: 52rem; margin: 0 auto; padding: 1.5rem; }
    .host-chrome { display: flex; align-items: center; gap: 1rem; padding-bottom: 0.75rem; border-bottom: 2px solid #0ea5e9; margin-bottom: 1rem; }
    .notifications { margin-left: auto; }
    /* A slot the gateway could not fill degrades to a reserved space rather than a jump. */
    .notifications[data-braid-fallback] { display: block; min-width: 8rem; min-height: 1.9rem; border: 1px dashed #cbd5e1; border-radius: 8px; }
    .badge { background: #0ea5e9; color: #fff; border-radius: 999px; padding: 0.15rem 0.6rem; font-size: 0.75rem; }
    nav { display: flex; gap: 0.75rem; }
    a { color: #0369a1; text-decoration: none; }
    a.active { font-weight: 700; text-decoration: underline; }
  `,
})
export class App {}
