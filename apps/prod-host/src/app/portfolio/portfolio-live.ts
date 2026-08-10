import {
  DestroyRef,
  Injectable,
  computed,
  inject,
  signal,
} from '@angular/core';
import { Lab } from '../lab';
import {
  API_BASE,
  BreachSchemaV1,
  TickSchemaV1,
  WS_TICKER_URL,
  type LiquidityBreachV1,
  type TickV1,
} from './contracts';

const MAX_TICKS_SHOWN = 20;
const MAX_BREACHES_SHOWN = 6;
const WS_RECONNECT_BASE_MS = 500;
const WS_RECONNECT_MAX_MS = 8_000;
const TOAST_DURATION_MS = 10_000;

export interface BreachToast {
  readonly id: number;
  readonly breach: LiquidityBreachV1;
}

/**
 * Owns the live connections for the whole Portfolio tab: one WebSocket, one
 * EventSource, shared by the fund list and (indirectly, via the toast strip)
 * the fund detail route.
 *
 * Provided on the `portfolio` route rather than `providedIn: 'root'` — see
 * `app.routes.ts`. A root singleton would open its sockets on first use and
 * never close them; scoping this to the route means the connections exist
 * only while some portfolio screen is open, and close via `DestroyRef` the
 * moment the user leaves the tab. That is also what makes the ticker feel
 * "continuous": it survives navigating from the fund list into a fund's
 * detail page and back, because it isn't owned by either of those routed
 * components.
 *
 * The remote's `FundDetail` cannot use this service — it is a separately
 * built application and cannot import a class from the host's bundle. It
 * keeps its own independent WebSocket/SSE connections, by design; see the
 * note in `fund-detail.ts`.
 */
@Injectable()
export class PortfolioLive {
  private readonly lab = inject(Lab);
  private readonly destroyRef = inject(DestroyRef);

  readonly ticks = signal<TickV1[]>([]);
  readonly wsConnected = signal(false);
  readonly breaches = signal<LiquidityBreachV1[]>([]);
  readonly toasts = signal<BreachToast[]>([]);

  /** Ticker pinned via the typeahead, or null for the full rolling feed. */
  readonly focusedTicker = signal<string | null>(null);
  /** Fund currently open in the drawer, so the list can show which one. */
  readonly selectedFundId = signal<string | null>(null);

  /** The most recent tick for the pinned ticker — the typeahead's payoff. */
  readonly focusedTick = computed(() => {
    const symbol = this.focusedTicker();
    if (!symbol) return null;
    return this.ticks().find((t) => t.ticker === symbol) ?? null;
  });

  /** The strip shows one ticker when pinned, everything otherwise. */
  readonly visibleTicks = computed(() => {
    const symbol = this.focusedTicker();
    const all = this.ticks();
    return symbol ? all.filter((t) => t.ticker === symbol) : all;
  });

  private ws: WebSocket | null = null;
  private wsReconnectMs = WS_RECONNECT_BASE_MS;
  private wsReconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private sse: EventSource | null = null;
  private toastSeq = 0;

  constructor() {
    this.connectTicker();
    this.connectBreachFeed();

    this.destroyRef.onDestroy(() => {
      clearTimeout(this.wsReconnectTimer);
      this.ws?.close();
      this.sse?.close();
    });
  }

  dismissToast(id: number): void {
    this.toasts.update((prev) => prev.filter((t) => t.id !== id));
  }

  private connectTicker(): void {
    clearTimeout(this.wsReconnectTimer);
    const ws = new WebSocket(WS_TICKER_URL);
    this.ws = ws;

    ws.onopen = () => {
      this.wsConnected.set(true);
      this.wsReconnectMs = WS_RECONNECT_BASE_MS;
      this.lab.write('ok', 'portfolio/ticker', 'websocket connected');
    };

    ws.onmessage = (event) => {
      let frame: { event?: string; data?: unknown };
      try {
        frame = JSON.parse(event.data);
      } catch {
        return;
      }
      if (frame.event !== 'tick') return;

      const result = TickSchemaV1.read(frame.data);
      if (!result.ok) {
        this.lab.write(
          'warn',
          'portfolio/ticker',
          `tick refused: ${result.reason}`,
        );
        return;
      }
      this.ticks.update((prev) =>
        [result.value, ...prev].slice(0, MAX_TICKS_SHOWN),
      );
    };

    ws.onclose = () => {
      this.wsConnected.set(false);
      if (this.ws !== ws) return; // superseded by a newer connection
      this.lab.write(
        'warn',
        'portfolio/ticker',
        `disconnected — retrying in ${this.wsReconnectMs}ms`,
      );
      this.wsReconnectTimer = setTimeout(
        () => this.connectTicker(),
        this.wsReconnectMs,
      );
      this.wsReconnectMs = Math.min(
        this.wsReconnectMs * 2,
        WS_RECONNECT_MAX_MS,
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
      if (!result.ok) {
        this.lab.write(
          'warn',
          'portfolio/breach',
          `breach refused: ${result.reason}`,
        );
        return;
      }
      // `warn`, not `fail`, whatever the severity. A liquidity breach is a
      // *domain* event the demo is supposed to produce — logging it as a
      // failure made the activity counter read "9 failed" on a session where
      // nothing had gone wrong, which is how a diagnostic surface loses the
      // reader's trust. The severity is in the message where it belongs.
      this.lab.write(
        'warn',
        'portfolio/breach',
        `${result.value.severity}: ${result.value.trigger.description}`,
      );
      this.breaches.update((prev) =>
        [result.value, ...prev].slice(0, MAX_BREACHES_SHOWN),
      );

      const id = ++this.toastSeq;
      this.toasts.update((prev) => [...prev, { id, breach: result.value }]);
      setTimeout(() => this.dismissToast(id), TOAST_DURATION_MS);
    };

    sse.onerror = () => {
      // EventSource retries on its own; just note it happened.
      this.lab.write(
        'warn',
        'portfolio/breach',
        'SSE connection interrupted — browser will auto-retry',
      );
    };
  }
}
