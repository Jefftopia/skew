import { Component, inject, signal, computed } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { Router } from '@angular/router';
import { createVersionedStore, webStorageDriver } from '@skew/core';
import { Lab } from '../lab';
import { PortfolioLive } from './portfolio-live';
import {
  API_BASE,
  FUND_CONTRACT_URL,
  FundListSchemaV1,
  FundSchemaV1,
  SELECTED_FUND_KEY,
  fundContractResolver,
  type FundV1,
} from './contracts';
import { TourAnchor } from '../tour/tour-anchor';
import { JsonDiff } from '../boundary/json-diff';

/**
 * The fund list and breach feed. The ticker no longer lives here — it moved
 * to `PortfolioLive`/`PortfolioLayout` so it keeps running while a fund's
 * detail page is open, instead of resetting every time this component is
 * torn down and rebuilt by the router.
 */
@Component({
  selector: 'host-portfolio-page',
  imports: [TourAnchor, JsonDiff],
  styleUrls: ['../cards.css', './portfolio.css'],
  template: `
    <div class="dashboard">
      <section class="panel" hostTourAnchor="fund-list">
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

      <section class="panel" hostTourAnchor="contract-card">
        <h3>Data from the future — cured by the contract</h3>
        <dl class="meta">
          <dt>Tests</dt>
          <dd>
            <code>GET /api/v2/funds</code> read through
            <code>FundListSchemaV1</code>, then again through
            <code>readResolving</code>
          </dd>
          <dt>Enables</dt>
          <dd>
            An honest v1 projection of a v2 response, using down-migrations
            learned at runtime from
            <code>/.well-known/skew/contracts/portfolio-fund</code>
          </dd>
          <dt>Without it</dt>
          <dd>
            <code>ahead</code> is a dead end until this app redeploys — the
            knowledge to migrate down shipped after this build did
          </dd>
        </dl>
        <button
          class="ghost"
          (click)="readFromTheFuture()"
          [disabled]="futureBusy()"
        >
          {{ futureBusy() ? 'Fetching…' : 'Fetch v2 & read as v1' }}
        </button>
        @if (futureError(); as e) {
          <div class="verdict bad"><strong>Failed</strong>{{ e }}</div>
        }
        @if (future(); as f) {
          @if (f.refusal) {
            <div class="verdict bad">
              <strong>1 · Refused — ahead</strong>{{ f.refusal }}
            </div>
          } @else {
            <div class="verdict">
              <strong>1 · No refusal needed</strong>The page already knew the
              way down — a resolved contract or a loaded remote had registered
              the step before this read ran.
            </div>
          }
          <div class="verdict ok">
            <strong>2 · Downgraded v{{ f.downgradedFrom }} → v1</strong>
            {{ f.fundCount }} funds, projected honestly onto the shape this
            build understands. Dropped on the way down:
            <code>{{ f.lossy.join(', ') }}</code>
          </div>
          @if (f.sampleBefore !== undefined) {
            <host-json-diff
              [before]="f.sampleBefore"
              [after]="f.sampleAfter"
              [lossyPaths]="f.lossy"
              [beforeLabel]="'v' + f.downgradedFrom + ' · as the API sent it'"
              afterLabel="v1 · as this build read it"
            />
          }
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

  protected readonly futureBusy = signal(false);
  protected readonly futureError = signal<string | null>(null);
  protected readonly future = signal<{
    refusal: string | null;
    downgradedFrom: number | null;
    lossy: readonly string[];
    fundCount: number;
    /**
     * One fund from each side, for the diff. One rather than all five: the
     * projection is identical in shape for every row, and five copies of the
     * same change is a wall to scroll past rather than a thing to read.
     */
    sampleBefore: unknown;
    sampleAfter: unknown;
  } | null>(null);

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
      next: async (body) => {
        // `readResolving` reads through the schema exactly as `.read()` would;
        // the difference only appears on `ahead`. This build understands v1
        // and nothing newer — but the API publishes its contract at a
        // well-known URL, and an origin is always at least as new as the data
        // it serves. So when the response is from the future, the resolver
        // fetches the contract, learns the down-migrations this build shipped
        // too early to know, and reads an honest (lossy, and labeled as such)
        // projection instead of dead-ending.
        const result = await fundContractResolver.readResolving(
          FundListSchemaV1,
          body,
          FUND_CONTRACT_URL,
        );
        if (!result.ok) {
          this.lab.write(
            'fail',
            'portfolio/funds',
            `refused: ${result.reason}`,
          );
          this.fundsError.set(
            result.reason === 'ahead'
              ? `server sent a newer contract (v${result.found}), and its published contract could not be resolved`
              : result.message,
          );
          return;
        }
        if (result.downgradedFrom) {
          this.lab.write(
            'warn',
            'portfolio/funds',
            `response was v${result.downgradedFrom}; projected down to v1 via the resolved contract — ` +
              `lost: ${result.lossyPaths.join(', ') || '(nothing)'}`,
          );
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

  /**
   * The contract cure, live against the running API.
   *
   * Step 1 fetches `/v2/funds` — a response from this build's future — and
   * reads it plainly: `ahead`, the classic dead end. Step 2 is the same read
   * through `readResolving`: the resolver fetches the contract the API
   * publishes, learns the down-migrations this build shipped too early to
   * know, and the identical bytes read as an honest v1 projection. If the
   * page already knew the way down (a prior cure, or the remote's bundle
   * registered its chain), step 1 downgrades immediately and the card says
   * that instead — the demo reports what happened, not what it expected.
   */
  protected async readFromTheFuture(): Promise<void> {
    this.futureBusy.set(true);
    this.future.set(null);
    this.futureError.set(null);
    try {
      this.lab.write(
        'step',
        'portfolio/future',
        'GET /api/v2/funds — a contract newer than this build',
      );
      const body = await firstValueFrom(
        this.http.get(`${API_BASE}/v2/funds`),
      );

      const plain = FundListSchemaV1.read(body);
      const refusal = plain.ok ? null : plain.message;
      if (refusal) {
        this.lab.write('warn', 'portfolio/future', `refused: ${refusal}`);
      }

      const cured = await fundContractResolver.readResolving(
        FundListSchemaV1,
        body,
        FUND_CONTRACT_URL,
      );
      if (!cured.ok) {
        this.lab.write('fail', 'portfolio/future', cured.message);
        this.futureError.set(cured.message);
        return;
      }

      this.lab.write(
        'ok',
        'portfolio/future',
        `downgraded v${cured.downgradedFrom} → v1 via the resolved contract; ` +
          `lost: ${cured.lossyPaths.join(', ')}`,
      );
      const sent = (body as { payload?: unknown[] } | null)?.payload;
      this.future.set({
        refusal,
        downgradedFrom: cured.downgradedFrom,
        lossy: cured.lossyPaths,
        fundCount: cured.value.length,
        sampleBefore: Array.isArray(sent) ? sent[0] : undefined,
        sampleAfter: cured.value[0],
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.lab.write('fail', 'portfolio/future', message);
      this.futureError.set(
        `Could not reach the API: ${message}. Is it running (npm run api)?`,
      );
    } finally {
      this.futureBusy.set(false);
    }
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
