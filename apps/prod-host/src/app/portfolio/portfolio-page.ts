import { Component, inject, signal, computed } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import { createVersionedStore, webStorageDriver } from '@skew/core';
import { Lab } from '../lab';
import { PortfolioLive } from './portfolio-live';
import {
  API_BASE,
  FundListSchemaV1,
  FundSchemaV1,
  SELECTED_FUND_KEY,
  type FundV1,
} from './contracts';

/**
 * The fund list and breach feed. The ticker no longer lives here — it moved
 * to `PortfolioLive`/`PortfolioLayout` so it keeps running while a fund's
 * detail page is open, instead of resetting every time this component is
 * torn down and rebuilt by the router.
 */
@Component({
  selector: 'host-portfolio-page',
  styleUrls: ['../cards.css', './portfolio.css'],
  template: `
    <div class="dashboard">
      <section class="panel">
        <h3>Funds — pinned to <code>v1</code></h3>
        <dl class="meta">
          <dt>Tests</dt>
          <dd>
            <code>GET /api/v1/funds</code> read through
            <code>FundListSchemaV1</code>
          </dd>
          <dt>Enables</dt>
          <dd>A typed, versioned read of the live fund book</dd>
          <dt>Without it</dt>
          <dd>
            A bare <code>.json()</code> cast — no proof the server sent v1 at
            all
          </dd>
        </dl>

        @if (fundsError(); as e) {
          <div class="verdict bad"><strong>Read refused</strong>{{ e }}</div>
        } @else if (funds().length === 0) {
          <p class="empty">Loading funds…</p>
        } @else {
          <div class="fund-list">
            @for (f of funds(); track f.id) {
              <div
                class="fund-row"
                [class.breached]="breachedFundIds().has(f.id)"
                [class.open]="live.selectedFundId() === f.id"
              >
                <div class="fund-row-main">
                  <button
                    class="fund-toggle"
                    (click)="toggleExpanded(f.id)"
                    [attr.aria-expanded]="expanded().has(f.id)"
                  >
                    {{ expanded().has(f.id) ? '▾' : '▸' }}
                  </button>
                  <button
                    class="fund-row-body"
                    (click)="toggleExpanded(f.id)"
                    [attr.aria-expanded]="expanded().has(f.id)"
                  >
                    <h4>{{ f.name }}</h4>
                    <div class="stats">
                      <span>{{ f.currency }} {{ formatMoney(f.nav) }}</span>
                      <span>cash {{ f.cashPct }}%</span>
                      <span>{{ f.holdings.length }} holdings</span>
                    </div>
                    @if (breachedFundIds().has(f.id)) {
                      <span class="breach-flag">named in latest breach</span>
                    }
                  </button>
                  <button
                    class="ghost detail-link"
                    [class.is-open]="live.selectedFundId() === f.id"
                    (click)="openFund(f)"
                  >
                    {{ live.selectedFundId() === f.id ? 'Open →' : 'Detail →' }}
                  </button>
                </div>

                @if (expanded().has(f.id)) {
                  <table class="holdings-table">
                    <thead>
                      <tr>
                        <th>Ticker</th>
                        <th>Name</th>
                        <th>Weight</th>
                        <th>Market value</th>
                      </tr>
                    </thead>
                    <tbody>
                      @for (h of f.holdings; track h.ticker) {
                        <tr>
                          <td>{{ h.ticker }}</td>
                          <td>{{ h.name }}</td>
                          <td>{{ h.weightPct }}%</td>
                          <td>
                            {{ f.currency }} {{ formatMoney(h.marketValue) }}
                          </td>
                        </tr>
                      }
                    </tbody>
                  </table>
                }
              </div>
            }
          </div>
        }
      </section>

      <section class="panel">
        <h3>Liquidity breach feed (SSE)</h3>
        <dl class="meta">
          <dt>Tests</dt>
          <dd>
            native <code>EventSource</code>, payloads read through
            <code>BreachSchemaV1</code>
          </dd>
          <dt>Enables</dt>
          <dd>Randomly-timed breach events, with suggested remediation</dd>
        </dl>
        @if (live.breaches().length === 0) {
          <p class="empty">Waiting for the first event…</p>
        } @else {
          <div class="breach-list">
            @for (b of live.breaches(); track b.id) {
              <div
                class="breach-card"
                [class.breach]="b.severity === 'breach'"
                [class.warning]="b.severity === 'warning'"
              >
                <span class="sev">{{ b.severity }}</span> ·
                {{ b.trigger.description }}
                <div class="impacted-funds">
                  {{ b.impacted.map((i) => i.fundName + ' (' + i.cashPctAfter + '% cash)').join(', ') }}
                </div>
                <div class="action">{{ b.suggestedAction.rationale }}</div>
              </div>
            }
          </div>
        }
      </section>
    </div>
  `,
})
export class PortfolioPage {
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);
  private readonly lab = inject(Lab);
  protected readonly live = inject(PortfolioLive);

  protected readonly funds = signal<FundV1[]>([]);
  protected readonly fundsError = signal<string | null>(null);
  protected readonly expanded = signal<ReadonlySet<string>>(new Set());

  protected readonly breachedFundIds = computed(() => {
    const latest = this.live.breaches()[0];
    return new Set(latest ? latest.impacted.map((i) => i.fundId) : []);
  });

  private readonly selectedFundStore = createVersionedStore(FundSchemaV1, {
    driver: webStorageDriver('session'),
  });

  constructor() {
    this.loadFunds();
  }

  private loadFunds(): void {
    this.lab.write('step', 'portfolio/funds', 'GET /api/v1/funds');
    this.http.get(`${API_BASE}/v1/funds`).subscribe({
      next: (body) => {
        const result = FundListSchemaV1.read(body);
        if (!result.ok) {
          this.lab.write(
            'fail',
            'portfolio/funds',
            `refused: ${result.reason}`,
          );
          this.fundsError.set(
            result.reason === 'ahead'
              ? `server sent a newer contract (v${result.found})`
              : result.message,
          );
          return;
        }
        this.lab.write(
          'ok',
          'portfolio/funds',
          `${result.value.length} funds loaded`,
        );
        this.funds.set(result.value);
      },
      error: (err) => {
        this.lab.write(
          'fail',
          'portfolio/funds',
          `request failed: ${err.message ?? err}`,
        );
        this.fundsError.set(
          'Could not reach the portfolio API. Is it running (npm run api)?',
        );
      },
    });
  }

  protected toggleExpanded(fundId: string): void {
    this.expanded.update((prev) => {
      const next = new Set(prev);
      if (next.has(fundId)) next.delete(fundId);
      else next.add(fundId);
      return next;
    });
  }

  protected async openFund(fund: FundV1): Promise<void> {
    this.lab.write(
      'step',
      'portfolio/handoff',
      `writing v1 fund "${fund.id}" for the remote to read`,
    );
    await this.selectedFundStore.set(SELECTED_FUND_KEY, fund);
    this.live.selectedFundId.set(fund.id);
    // Same route, new param when the drawer is already open — `FundDetail`
    // swaps its context rather than being torn down and rebuilt.
    void this.router.navigate(['/portfolio/fund', fund.id]);
  }

  protected formatMoney(n: number): string {
    return new Intl.NumberFormat('en-US', {
      notation: 'compact',
      maximumFractionDigits: 1,
    }).format(n);
  }
}
