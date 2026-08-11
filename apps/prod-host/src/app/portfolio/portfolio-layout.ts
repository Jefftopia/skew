import { Component, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Router, RouterOutlet } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { API_BASE } from './contracts';
import { PortfolioLive } from './portfolio-live';
import { PortfolioPage } from './portfolio-page';
import { DrawerShell } from '../shell/drawer-shell';
import { TickerTypeahead, type TickerOption } from './ticker-typeahead';
import { TourAnchor } from '../tour/tour-anchor';

/**
 * The Portfolio tab's shell.
 *
 * The fund list is rendered directly, not through the outlet — it must never
 * disappear. The outlet lives *inside the drawer* and holds the remote's fund
 * detail, so opening a fund adds a panel beside the list instead of replacing
 * the screen with it. Closing navigates back to `/portfolio`, which empties
 * the outlet and collapses the drawer.
 *
 * Selecting a different fund while the drawer is open re-navigates to the new
 * id: same component instance, new route param, and `FundDetail`'s `paramMap`
 * subscription swaps its context — the drawer changes what it is about
 * without closing and reopening.
 */
@Component({
  selector: 'host-portfolio-layout',
  imports: [
    RouterOutlet,
    DrawerShell,
    PortfolioPage,
    TickerTypeahead,
    TourAnchor,
  ],
  styleUrl: './portfolio-layout.css',
  template: `
    <div class="breach-bar" hostTourAnchor="breach-bar">
      <div>
        <strong>Liquidity events fire only when you ask.</strong>
        <span>
          Each one targets <code>TBILL-3M</code> — the one instrument every fund
          holds — so a single press shows up across the whole book at once, in
          the list, in every drill-down, and in the open panel.
        </span>
      </div>
      <button (click)="fireBreach()" [disabled]="firing()">
        {{ firing() ? 'Firing…' : 'Fire a liquidity breach' }}
      </button>
    </div>

    <div class="ticker-bar" hostTourAnchor="ticker-bar">
      <div class="ticker-search">
        <host-ticker-typeahead
          placeholder="Pin a ticker…"
          (selected)="pin($event)"
          (cleared)="unpin()"
        />
      </div>

      <div class="ticker-strip">
        <span class="conn-dot" [class.live]="live.wsConnected()"></span>
        @if (live.visibleTicks().length === 0) {
          <span class="empty">
            {{
              live.focusedTicker()
                ? 'Waiting for a tick on ' + live.focusedTicker() + '…'
                : 'Connecting to the ticker…'
            }}
          </span>
        } @else {
          @for (t of live.visibleTicks(); track t.at + t.ticker) {
            <span
              class="ticker-chip"
              [class.up]="t.direction === 'up'"
              [class.down]="t.direction === 'down'"
            >
              <span class="sym">{{ t.ticker }}</span>
              <span class="px">{{ t.price.toFixed(2) }}</span>
              <span class="arrow">{{
                t.direction === 'up' ? '▲' : t.direction === 'down' ? '▼' : '·'
              }}</span>
            </span>
          }
        }
      </div>
    </div>

    @if (live.focusedTick(); as t) {
      <div class="focus-card">
        <div class="focus-head">
          <strong>{{ t.ticker }}</strong>
          <span class="focus-name">{{ t.name }}</span>
          <span
            class="focus-px"
            [class.up]="t.direction === 'up'"
            [class.down]="t.direction === 'down'"
          >
            {{ t.price.toFixed(2) }}
            <span class="chg"
              >{{ t.changePct > 0 ? '+' : '' }}{{ t.changePct }}%</span
            >
          </span>
          <button class="unpin" (click)="unpin()">Unpin</button>
        </div>
        @if (t.impactedFunds.length > 0) {
          <p class="focus-caption">
            funds holding it, and this tick's effect on their NAV
          </p>
          <ul class="impact-list">
            @for (f of t.impactedFunds; track f.fundId) {
              <li>
                <span class="fund">{{ f.fundName }}</span>
                <span class="weight">{{ f.weightPct }}% weight</span>
                <span
                  class="nav"
                  [class.up]="f.navImpactPct > 0"
                  [class.down]="f.navImpactPct < 0"
                >
                  {{ f.navImpactPct > 0 ? '+' : '' }}{{ f.navImpactPct }}% NAV
                </span>
              </li>
            }
          </ul>
        } @else {
          <p class="focus-caption">No fund in the book holds this one.</p>
        }
      </div>
    }

    <host-drawer-shell
      [open]="drawerOpen()"
      [closable]="true"
      title="apps/prod-remote · ./FundDetail"
      (closed)="close()"
    >
      <host-portfolio-page />

      <div drawer>
        <router-outlet
          (activate)="drawerOpen.set(true)"
          (deactivate)="drawerOpen.set(false)"
        />
      </div>
    </host-drawer-shell>

    <div class="toast-stack">
      @for (t of live.toasts(); track t.id) {
        <div
          class="toast"
          [class.breach]="t.breach.severity === 'breach'"
          [class.warning]="t.breach.severity === 'warning'"
        >
          <button
            class="dismiss"
            (click)="live.dismissToast(t.id)"
            aria-label="Dismiss"
          >
            ×
          </button>
          <span class="sev">Liquidity {{ t.breach.severity }}</span>
          {{ t.breach.trigger.description }}
        </div>
      }
    </div>
  `,
})
export class PortfolioLayout {
  protected readonly live = inject(PortfolioLive);
  private readonly router = inject(Router);

  protected readonly drawerOpen = signal(false);
  protected readonly firing = signal(false);

  private readonly http = inject(HttpClient);

  /**
   * Asks the API to emit one breach to every connected client.
   *
   * The stream has no timer any more — see `events.controller.ts`. An event
   * that arrives on its own schedule makes it impossible to tell whether what
   * you just saw was caused by what you just did, which is a poor property for
   * a demo about cause and effect.
   */
  protected async fireBreach(): Promise<void> {
    this.firing.set(true);
    try {
      await firstValueFrom(
        this.http.post(`${API_BASE}/events/liquidity/trigger`, {}),
      );
    } catch {
      // The SSE panel already shows a connection problem; nothing to add.
    } finally {
      this.firing.set(false);
    }
  }

  protected pin(option: TickerOption): void {
    this.live.focusedTicker.set(option.ticker);
  }

  protected unpin(): void {
    this.live.focusedTicker.set(null);
  }

  protected close(): void {
    this.live.selectedFundId.set(null);
    void this.router.navigate(['/portfolio']);
  }
}
