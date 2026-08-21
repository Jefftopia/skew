import { Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { SkewRecoveryService } from '@braidlabs/angular-router';
import { BUILD_IDENTITY } from './app.config';
import { VERSIONS } from './domain';
import { Simulator } from './simulator';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet],
  styles: [
    `
      :host { display: block; max-width: 1000px; margin: 0 auto; padding: 2rem 1.25rem 4rem;
              font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; color: #16202e; }
      header { margin-bottom: 1.5rem; }
      h1 { margin: 0 0 .25rem; font-size: 1.7rem; letter-spacing: -.02em; }
      .sub { color: #5b6779; font-size: .85rem; margin: 0; }
      .id { font-size: .72rem; color: #8b96a6; margin-top: .35rem; }
      .sim { border: 1px solid #d8dee9; border-left: 4px solid #8FBFE0; border-radius: 12px;
             padding: .9rem 1.1rem; margin-bottom: 1.4rem; background: #f8fbfd; }
      .sim h2 { margin: 0 0 .15rem; font-size: .78rem; text-transform: uppercase;
                letter-spacing: .11em; color: #1E3A5F; }
      .sim p { margin: 0 0 .7rem; font-size: .78rem; color: #5b6779; }
      .toggles { display: flex; gap: .5rem; flex-wrap: wrap; }
      .toggle { border: 1px solid #cfd9e4; background: #fff; border-radius: 999px;
                padding: .35rem .8rem; font-size: .74rem; font-weight: 700;
                cursor: pointer; color: #46536a; }
      .toggle.on { background: #1E3A5F; border-color: #1E3A5F; color: #fff; }
      .alert { border-radius: 12px; padding: .85rem 1rem; margin-bottom: 1.2rem;
               font-size: .82rem; display: flex; gap: .8rem; align-items: center;
               background: #fff7e6; border: 1px solid #f0d18a; color: #6b4b0d; }
      .alert button { margin-left: auto; border: 0; border-radius: 8px; padding: .4rem .8rem;
                      font-weight: 700; font-size: .74rem; cursor: pointer;
                      background: #1E3A5F; color: #fff; }
      .alert .why { font-size: .74rem; opacity: .8; display: block; margin-top: .15rem; }
    `,
  ],
  template: `
    <header>
      <h1>Skew — version skew, demonstrated</h1>
      <p class="sub">
        App 1 (data v{{ v.appOne.data }}, workflow {{ v.appOne.workflow }})
        loading App 2 (data v{{ v.appTwo.data }}, workflow {{ v.appTwo.workflow }}).
      </p>
      <p class="id">build <code>{{ build.buildId }}</code> · built {{ build.builtAt }}</p>
    </header>

    <section class="sim">
      <h2>Deploy simulator</h2>
      <p>
        These failures normally need an actual deployment to reproduce. Toggle one on,
        then load App 2.
      </p>
      <div class="toggles">
        <button class="toggle" [class.on]="sim.failChunk()" (click)="sim.toggleFailChunk()">
          {{ sim.failChunk() ? '✓ ' : '' }}Purge App 2's chunk
        </button>
        <button class="toggle" [class.on]="sim.staleOrigin()" (click)="sim.toggleStaleOrigin()">
          {{ sim.staleOrigin() ? '✓ ' : '' }}Origin serves a stale build
        </button>
        <button class="toggle" (click)="sim.reset()">Reset (clears recovery budget)</button>
      </div>
    </section>

    @if (skew.pending(); as pending) {
      <div class="alert">
        <div>
          <strong>Couldn't load App 2 — recovery was withheld.</strong>
          <span class="why">{{ explain(pending.reason) }}</span>
        </div>
        <button (click)="skew.recover()">Reload anyway</button>
      </div>
    }

    <router-outlet />
  `,
})
export class App {
  protected readonly sim = inject(Simulator);
  protected readonly skew = inject(SkewRecoveryService);
  protected readonly build = BUILD_IDENTITY;
  protected readonly v = VERSIONS;

  /** The whole point: *why* it refused to reload matters more than that it did. */
  protected explain(reason: string): string {
    switch (reason) {
      case 'loop-detected':
        return 'The origin is serving an older build than the one running. Reloading would fetch the same stale bundle and fail again — forever — so it stopped.';
      case 'offline':
        return 'You appear to be offline. Reloading now would replace a working app with a browser error page.';
      case 'exhausted':
        return 'The recovery budget for this build is spent. Reloading again would loop.';
      default:
        return 'Recovery was left to you rather than taken automatically.';
    }
  }
}
