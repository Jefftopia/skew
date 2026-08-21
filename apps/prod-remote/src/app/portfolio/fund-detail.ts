import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { ActivatedRoute } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { createVersionedStore, webStorageDriver } from '@braidlabs/skew';
import { OutboxService } from '@braidlabs/angular-data';
import {
  API_BASE,
  BreachSchemaV1,
  FundSchemaV2,
  SELECTED_FUND_KEY,
  TickSchemaV1,
  WS_TICKER_URL,
  type FundV2,
  type LiquidityBreachV1,
} from './contracts';
import {
  enqueueOrderV1,
  enqueueOrderV2,
  registerOrderMutation,
} from './order-outbox';
import { isSimulatedOffline, setSimulatedOffline } from './offline';
import { trace } from '../trace';
import { TickerTypeahead } from './ticker-typeahead';
import { JsonDiff } from './json-diff';
import { BUILD_IDENTITY } from '../../generated/build-id';

interface Outcome {
  readonly ok: boolean;
  readonly headline: string;
  readonly detail: string;
}

interface ReconRow {
  label: string;
  migrated: string;
  authoritative: string;
  differs: boolean;
  derived: boolean;
}

/**
 * The centrepiece of the portfolio demo: three views of the same fund, side
 * by side.
 *
 * 1. **Handed over** — the v1 record the host wrote to `sessionStorage`,
 *    migrated forward by this build's `FundSchemaV2`. Fields v1 could not
 *    supply are filled with a value that is *visibly* a placeholder.
 * 2. **Authoritative** — `GET /api/v2/funds/:id`, this build's own schema,
 *    real per-fund data the server actually holds.
 * 3. **Difference** — where the migration's guess and the server's answer
 *    disagree. That gap, not either column alone, is the point.
 *
 * The migration is not "wrong" for guessing — it is the best answer available
 * from v1 data. Reconciling against the authoritative source is how the gap
 * becomes visible instead of silently wrong.
 */
@Component({
  selector: 'remote-fund-detail',
  imports: [TickerTypeahead, JsonDiff],
  styleUrls: ['../cards.css', './fund-detail.css'],
  template: `
    <div class="banner">
      <h2>Fund detail · draft schema v2</h2>
      <p>
        build <code>{{ build.buildId }}</code> · stamped {{ build.builtAt }}
      </p>
    </div>

    @if (loadError(); as e) {
      <div class="verdict bad">
        <strong>{{ e.headline }}</strong
        >{{ e.detail }}
      </div>
    } @else if (!authoritative()) {
      <p class="step">Loading…</p>
    } @else {
      @if (liveUpdate(); as u) {
        <div class="update-banner">
          <span>{{ u }}</span>
          <button (click)="refreshAuthoritative()">Refresh</button>
        </div>
      }

      @if (activeBreach(); as b) {
        <div class="breach-banner">
          <strong>Liquidity {{ b.severity }} affecting this fund.</strong>
          {{ b.suggestedAction.rationale }}
        </div>
      }

      <div class="card">
        <h3>{{ authoritative()!.name }}</h3>
        <dl class="meta">
          <dt>Tests</dt>
          <dd>
            run envelope unwrapped, then payload migrated v1 → v2, then
            reconciled against <code>GET /api/v2/funds/:id</code>
          </dd>
          <dt>Enables</dt>
          <dd>
            Seeing exactly which fields were a guess and which were confirmed
          </dd>
        </dl>

        @if (reconRows().length > 0) {
          <table class="recon-table" data-tour="recon">
            <thead>
              <tr>
                <th>Field</th>
                <th>Migrated (from host's v1)</th>
                <th>Authoritative (server v2)</th>
              </tr>
            </thead>
            <tbody>
              @for (row of reconRows(); track row.label) {
                <tr [class.differs]="row.differs">
                  <td>
                    {{ row.label }}
                    @if (row.derived) {
                      <span class="derived-badge">derived</span>
                    }
                  </td>
                  <td>{{ row.migrated }}</td>
                  <td>{{ row.authoritative }}</td>
                </tr>
              }
            </tbody>
          </table>

          <!--
            The table above is a hand-picked shortlist. This is the whole
            record, and it is the more honest artifact: every field the
            migration had to invent shows up here whether or not somebody
            remembered to add a row for it, and the lines marked "guessed"
            are the ones a trader must not act on without confirming.
          -->
          <details class="recon-diff" data-tour="recon-diff">
            <summary>Compare the full records</summary>
            <remote-json-diff
              [before]="migrated()"
              [after]="authoritative()"
              [derivedPaths]="migratedDerived()"
              beforeLabel="migrated from the host's v1"
              afterLabel="authoritative · server v2"
            />
          </details>
        }
      </div>

      <div class="card">
        <h3>Respond to the breach</h3>
        <dl class="meta">
          <dt>Tests</dt>
          <dd>
            the outbox — <code>enqueue()</code> then <code>flush()</code> —
            against a versioned mutation
          </dd>
          <dt>Enables</dt>
          <dd>
            An order that survives a reload, and a client that migrates itself
            after a 409
          </dd>
        </dl>
        <p>
          Pre-filled from the active breach's suggested action, if any. The
          "queue as v1" button deliberately sends the old shape, so the
          409-then-migrate path can be seen rather than only happening by
          accident.
        </p>

        <form class="order-form" data-tour="order-form" (submit)="$event.preventDefault()">
          <label
            >Action
            <select
              [value]="orderAction()"
              (change)="orderAction.set($any($event.target).value)"
            >
              <option value="raise-cash">Raise cash</option>
              <option value="sell-holding">Sell holding</option>
              <option value="defer-redemption">Defer redemption</option>
            </select>
          </label>
          <div class="field">
            <span class="field-label">Ticker (if selling)</span>
            <remote-ticker-typeahead
              [value]="orderTicker()"
              (selected)="orderTicker.set($event)"
            />
          </div>
          <label
            >Amount (USD)
            <input
              type="number"
              [value]="orderAmount()"
              (input)="orderAmount.set(+$any($event.target).value)"
            />
          </label>
        </form>

        <div class="order-actions">
          <button (click)="submitOrder()">Submit order (v2)</button>
          <button class="ghost" (click)="submitOrderAsV1()">
            Queue as v1 (demonstrate skew)
          </button>
        </div>

        <!--
          The offline half of the outbox story. Submitting while "offline"
          queues the order durably (persistOutbox — it survives a reload);
          flipping back online flushes the queue. The toggle only gates this
          demo's own POST, but the failure it produces is the real one.
        -->
        <div class="offline-bar" data-tour="offline-bar" [class.off]="offline()">
          <label class="offline-toggle">
            <input
              type="checkbox"
              [checked]="offline()"
              (change)="toggleOffline($any($event.target).checked)"
            />
            Simulate offline
          </label>
          @if (outboxPending() > 0) {
            <span class="pending-badge"
              >{{ outboxPending() }} order(s) waiting to sync</span
            >
            <button class="ghost" [disabled]="offline()" (click)="syncNow()">
              Sync now
            </button>
          } @else if (offline()) {
            <span class="pending-hint"
              >Orders submitted now will queue and survive a reload.</span
            >
          }
        </div>

        @if (orderOutcome(); as o) {
          <div class="verdict" [class.ok]="o.ok" [class.bad]="!o.ok">
            <strong>{{ o.headline }}</strong
            >{{ o.detail }}
          </div>
        }
      </div>
    }
  `,
})
export class FundDetail {
  protected readonly build = BUILD_IDENTITY;

  private readonly route = inject(ActivatedRoute);
  private readonly http = inject(HttpClient);
  private readonly outbox = inject(OutboxService);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly migrated = signal<FundV2 | null>(null);
  protected readonly authoritative = signal<FundV2 | null>(null);
  /**
   * Which fields of the migrated record are guesses — taken from the read
   * result rather than maintained here, so it cannot drift from what the
   * migration actually did.
   */
  protected readonly migratedDerived = signal<readonly string[]>([]);
  protected readonly loadError = signal<Outcome | null>(null);
  protected readonly liveUpdate = signal<string | null>(null);
  protected readonly activeBreach = signal<LiquidityBreachV1 | null>(null);

  protected readonly orderAction = signal<
    'raise-cash' | 'sell-holding' | 'defer-redemption'
  >('raise-cash');
  protected readonly orderTicker = signal('');
  protected readonly orderAmount = signal(0);
  protected readonly orderOutcome = signal<Outcome | null>(null);
  protected readonly offline = signal(isSimulatedOffline());
  protected readonly outboxPending = this.outbox.pendingCount;

  protected readonly reconRows = computed<ReconRow[]>(() => {
    const m = this.migrated();
    const a = this.authoritative();
    if (!m || !a) return [];

    const rows: ReconRow[] = [
      row('Base currency', m.baseCurrency, a.baseCurrency, false),
      row('NAV', money(m.nav.amount), money(a.nav.amount), false),
      row(
        'Cash %',
        `${m.liquidity.cashPct}%`,
        `${a.liquidity.cashPct}%`,
        false,
      ),
      row('HQLA %', `${m.liquidity.hqlaPct}%`, `${a.liquidity.hqlaPct}%`, true),
      row(
        'Redemption cover (days)',
        String(m.liquidity.redemptionCoverDays),
        String(a.liquidity.redemptionCoverDays),
        true,
      ),
      row(
        'Asset class',
        m.classification.assetClass,
        a.classification.assetClass,
        true,
      ),
      row(
        'Strategy',
        m.classification.strategy,
        a.classification.strategy,
        true,
      ),
    ];

    const holdingsByTicker = new Map(a.holdings.map((h) => [h.ticker, h]));
    for (const mh of m.holdings) {
      const ah = holdingsByTicker.get(mh.ticker);
      if (!ah) continue;
      rows.push(
        row(
          `${mh.ticker} liquidity tier`,
          mh.liquidityTier,
          ah.liquidityTier,
          true,
        ),
      );
    }

    return rows;
  });

  private fundIdValue: string | null = null;
  private ws: WebSocket | null = null;
  private sse: EventSource | null = null;

  constructor() {
    registerOrderMutation(this.outbox);

    this.route.paramMap.subscribe((params) => {
      const id = params.get('id');
      if (!id || id === this.fundIdValue) return;
      this.fundIdValue = id;
      this.load(id);
    });

    this.connectTicker();
    this.connectBreachFeed();

    this.destroyRef.onDestroy(() => {
      this.ws?.close();
      this.sse?.close();
    });
  }

  private async load(fundId: string): Promise<void> {
    this.loadError.set(null);
    this.migrated.set(null);
    this.authoritative.set(null);
    this.migratedDerived.set([]);

    // 1 — the handed-over record, migrated forward.
    trace(
      'step',
      'fund-detail',
      `reading handed-over fund "${fundId}" from sessionStorage`,
      true,
    );
    const store = createVersionedStore(FundSchemaV2, {
      driver: webStorageDriver('session'),
    });
    const handed = await store.get(SELECTED_FUND_KEY);

    if (!handed.ok) {
      trace(
        'fail',
        'fund-detail',
        `handed-over record refused: ${handed.reason}`,
        true,
      );
      this.loadError.set({
        ok: false,
        headline: `Handed-over record refused — ${handed.reason}`,
        detail:
          handed.reason === 'ahead'
            ? 'The host wrote a fund from a newer contract than this build understands. Refusing rather than rendering a partial record.'
            : 'No fund was handed over. Open this page by clicking a fund on the Portfolio tab.',
      });
      return;
    }

    if (handed.value.id !== fundId) {
      // Handed-over data is for a different fund than the URL names — stale
      // sessionStorage from a previous selection. Fetch authoritative only.
      trace(
        'warn',
        'fund-detail',
        'handed-over fund does not match the URL; showing authoritative only',
        true,
      );
    } else {
      // The schema now reports provenance directly: derivedPaths is the
      // library's own list of which fields below are guesses, not a list this
      // component maintains by hand.
      trace(
        'ok',
        'fund-detail',
        handed.migratedFrom
          ? `migrated v${handed.migratedFrom} → v2 · guessed: ${handed.derivedPaths.join(', ') || '(nothing)'}`
          : 'already v2',
        true,
      );
      this.migrated.set(handed.value);
      this.migratedDerived.set(handed.derivedPaths);
    }

    await this.fetchAuthoritative(fundId);
  }

  private async fetchAuthoritative(fundId: string): Promise<void> {
    trace('step', 'fund-detail', `GET /v2/funds/${fundId}`, true);
    try {
      const body = await firstValueFrom(
        this.http.get(`${API_BASE}/v2/funds/${fundId}`),
      );
      const result = FundSchemaV2.read(body);
      if (!result.ok) {
        trace(
          'fail',
          'fund-detail',
          `authoritative read refused: ${result.reason}`,
          true,
        );
        this.loadError.set({
          ok: false,
          headline: 'Authoritative read refused',
          detail: result.message,
        });
        return;
      }
      trace('ok', 'fund-detail', 'authoritative fund loaded', true);
      this.authoritative.set(result.value);
      this.liveUpdate.set(null);
    } catch (err) {
      trace('fail', 'fund-detail', `authoritative fetch failed: ${err}`, true);
      this.loadError.set({
        ok: false,
        headline: 'Could not reach the portfolio API',
        detail: 'Is it running? (npm run api)',
      });
    }
  }

  protected refreshAuthoritative(): void {
    if (this.fundIdValue) void this.fetchAuthoritative(this.fundIdValue);
  }

  private connectTicker(): void {
    const ws = new WebSocket(WS_TICKER_URL);
    this.ws = ws;
    ws.onmessage = (event) => {
      let frame: { event?: string; data?: unknown };
      try {
        frame = JSON.parse(event.data);
      } catch {
        return;
      }
      if (frame.event !== 'tick') return;
      const result = TickSchemaV1.read(frame.data);
      if (!result.ok) return;

      const impact = result.value.impactedFunds.find(
        (f) => f.fundId === this.fundIdValue,
      );
      if (!impact) return;

      // Offer a refresh; never silently rewrite what is on screen while
      // someone may be mid-decision on the order form below.
      this.liveUpdate.set(
        `${result.value.ticker} moved ${result.value.changePct > 0 ? '+' : ''}${result.value.changePct}%; ` +
          `this fund's NAV impact ≈ ${impact.navImpactPct > 0 ? '+' : ''}${impact.navImpactPct}%.`,
      );
    };
    ws.onerror = () => ws.close();
  }

  private connectBreachFeed(): void {
    const sse = new EventSource(`${API_BASE}/events/liquidity`);
    this.sse = sse;
    sse.onmessage = (event) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        return;
      }
      const result = BreachSchemaV1.read(parsed);
      if (!result.ok) return;
      if (!result.value.impacted.some((i) => i.fundId === this.fundIdValue))
        return;

      trace(
        'warn',
        'fund-detail',
        `breach names this fund: ${result.value.trigger.description}`,
        true,
      );
      this.activeBreach.set(result.value);
      this.orderAction.set(result.value.suggestedAction.kind);
      this.orderTicker.set(result.value.suggestedAction.ticker ?? '');
      this.orderAmount.set(result.value.suggestedAction.amount);
    };
  }

  protected async submitOrder(): Promise<void> {
    if (!this.fundIdValue) return;
    const breach = this.activeBreach();
    const order = {
      fundId: this.fundIdValue,
      action: this.orderAction(),
      ticker: this.orderTicker() || undefined,
      amount: { value: this.orderAmount(), currency: 'USD' },
      breachRef: breach?.id ?? 'unknown',
      idempotencyKey: `order-${this.fundIdValue}-${Date.now()}`,
    };
    await enqueueOrderV2(this.outbox, order);
    await this.flushAndReport();
  }

  /** The deliberate skew demo — same form, queued at the old contract. */
  protected async submitOrderAsV1(): Promise<void> {
    if (!this.fundIdValue) return;
    await enqueueOrderV1(this.outbox, {
      fundId: this.fundIdValue,
      action: this.orderAction(),
      ticker: this.orderTicker() || undefined,
      amount: this.orderAmount(),
    });
    await this.flushAndReport();
  }

  protected toggleOffline(offline: boolean): void {
    setSimulatedOffline(offline);
    this.offline.set(offline);
    if (offline) {
      trace(
        'warn',
        'order',
        'simulated offline ON — orders will queue, not send',
        true,
      );
      return;
    }
    trace('ok', 'order', 'back online — flushing the queue', true);
    // Coming back online drains the queue without any further user action —
    // the outbox's whole promise is that queued intent survives the gap.
    if (this.outboxPending() > 0) void this.syncNow();
  }

  protected async syncNow(): Promise<void> {
    await this.flushAndReport();
  }

  private async flushAndReport(): Promise<void> {
    const result = await this.outbox.flush();
    if (result.sent > 0) {
      this.orderOutcome.set({
        ok: true,
        headline: 'Order accepted',
        detail: `${result.sent} order(s) sent. Watch the trace panel for the sequence.`,
      });
    } else if (result.remaining > 0) {
      this.orderOutcome.set(
        this.offline()
          ? {
              ok: true,
              headline: 'Queued — offline',
              detail:
                `${result.remaining} order(s) held in the durable outbox. They survive a reload; ` +
                'flip the offline switch back and they send. Nothing was lost.',
            }
          : {
              ok: false,
              headline: 'Order still queued',
              detail: `${result.remaining} order(s) still pending — see the trace panel and onOutboxError for why.`,
            },
      );
    }
  }
}

function row(
  label: string,
  migrated: string,
  authoritative: string,
  derived: boolean,
): ReconRow {
  return {
    label,
    migrated,
    authoritative,
    differs: migrated !== authoritative,
    derived,
  };
}

function money(n: number): string {
  return new Intl.NumberFormat('en-US', {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(n);
}
