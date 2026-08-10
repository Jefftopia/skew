import { Component, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  NavigationEnd,
  NavigationError,
  NavigationStart,
  Router,
  RouterOutlet,
  RouterLink,
  RouterLinkActive,
} from '@angular/router';
import { SkewRecoveryService } from '@skew/angular-router';
import { BUILD_IDENTITY } from './app.config';
import { originIsRolledBack } from './origin';
import { Lab } from './lab';
import { ActivityFeed } from './activity-feed';

@Component({
  selector: 'host-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, ActivityFeed],
  styleUrl: './app.css',
  template: `
    <header>
      <div class="badge">HOST · independently deployed</div>
      <h1>Skew — two builds, one page</h1>
      <p class="sub">
        This app was built and deployed on its own. It knows the remote only as
        a URL, resolved at runtime. Everything below is a production bundle;
        nothing is simulated.
      </p>
      <p class="id">
        build <code>{{ build.buildId }}</code> · stamped {{ build.builtAt }}
        @if (rolledBack) {
          <span class="warn">· probing the ROLLBACK manifest</span>
        }
      </p>
    </header>

    <!--
      Tabs. Basics is the default (the redirect from the root path lands here) and holds
      everything the demo already did — module federation, chunk recovery,
      draft migration, the ahead/behind envelope story. Portfolio is the new
      material: the mock investment API, SSE, WebSocket, and the remote's
      three-way reconciliation view. Both tabs share the protections switch
      below, because both are demonstrating the same library.
    -->
    <nav class="tabs">
      <a routerLink="/basics" routerLinkActive="active">Basics</a>
      <a routerLink="/portfolio" routerLinkActive="active">Portfolio</a>
    </nav>

    <!--
      The before/after control.

      Off does not put @skew into a "pretend to fail" mode — it makes the
      packages inert, so every scenario below runs the plain code you would
      have written instead. The failures are produced, not depicted.
    -->
    <div class="switch" [class.off]="!lab.guarded()">
      <div>
        <strong>{{
          lab.guarded() ? 'Protections ON' : 'Protections OFF'
        }}</strong>
        <span>{{
          lab.guarded()
            ? 'Envelopes checked, migrations run, chunk loads retried and classified.'
            : '@skew is inert — bare reads and writes, no retry, no recovery. Re-run any scenario to see what it costs.'
        }}</span>
      </div>
      <button (click)="lab.toggle()">
        {{
          lab.guarded() ? 'Turn protections off' : 'Turn protections back on'
        }}
      </button>
    </div>

    <host-activity-feed />

    @if (skew.pending(); as pending) {
      <div class="alert">
        <div>
          <strong
            >Couldn't load the remote — recovery was withheld on
            purpose.</strong
          >
          <span class="why">{{ explain(pending.reason) }}</span>
          @if (pending.serverBuildId) {
            <span class="why"
              >origin reports build <code>{{ pending.serverBuildId }}</code
              >.</span
            >
          }
        </div>
        <button (click)="skew.recover()">Reload anyway</button>
      </div>
    }

    <router-outlet />
  `,
})
export class App {
  protected readonly lab = inject(Lab);
  protected readonly skew = inject(SkewRecoveryService);
  protected readonly build = BUILD_IDENTITY;
  protected readonly rolledBack = originIsRolledBack();

  constructor() {
    /**
     * Traces the navigation itself, independently of `@skew`.
     *
     * Without this the unprotected path is invisible: you click, nothing
     * happens, and there is nothing to read. "Nothing happened" is the most
     * important observation in the whole demo — a dead link with no feedback is
     * precisely what a user reports as "the app is broken" — so it has to be
     * written down rather than merely not contradicted.
     *
     * Deliberately a plain router subscription, so it keeps reporting when the
     * protections are off and every `@skew` code path has stood down.
     */
    inject(Router)
      .events.pipe(takeUntilDestroyed())
      .subscribe((event) => {
        if (event instanceof NavigationStart) {
          this.lab.write('step', 'navigate', `navigating to ${event.url}`);
        } else if (event instanceof NavigationEnd) {
          this.lab.write(
            'ok',
            'navigate',
            `arrived at ${event.urlAfterRedirects}`,
          );
        } else if (event instanceof NavigationError) {
          const message =
            event.error instanceof Error
              ? event.error.message
              : String(event.error);
          this.lab.write(
            'fail',
            'navigate',
            `${event.url} failed — ${message}`,
          );
          if (!this.lab.guarded()) {
            this.lab.write(
              'warn',
              'navigate',
              'protections off: nothing classifies this. The router stops, the ' +
                'address bar still says the old route, and the user sees a dead link.',
            );
          }
        }
      });
  }

  /** *Why* it refused to reload matters more than the fact that it did. */
  protected explain(reason: string): string {
    switch (reason) {
      case 'loop-detected':
        return 'The origin is serving an older build than the one running in this tab. Reloading would fetch the same stale entry document, fail identically, and reload again — forever. That is a bricked tab, so it stopped.';
      case 'offline':
        return 'This device appears to be offline. Reloading now would replace a working application with a browser error page, and lose whatever is on screen.';
      case 'exhausted':
        return 'The automatic recovery budget for this build is already spent. Another reload would be a loop.';
      default:
        return 'Recovery was handed to you rather than taken automatically.';
    }
  }
}
