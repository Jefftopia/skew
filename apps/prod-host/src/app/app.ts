import { Component, inject } from '@angular/core';
import { RouterOutlet, RouterLink } from '@angular/router';
import { SkewRecoveryService } from '@skew/angular-router';
import { BUILD_IDENTITY } from './app.config';
import { originIsRolledBack } from './origin';

@Component({
  selector: 'host-root',
  imports: [RouterOutlet, RouterLink],
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
      <nav>
        <a routerLink="/">Host</a>
        <a routerLink="/editor">Open the remote editor &rarr;</a>
      </nav>
    </header>

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
  protected readonly skew = inject(SkewRecoveryService);
  protected readonly build = BUILD_IDENTITY;
  protected readonly rolledBack = originIsRolledBack();

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
