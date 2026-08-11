import { Injectable, OnModuleDestroy } from '@nestjs/common';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
} from '@nestjs/websockets';
import { funds } from './mock-data';

export interface TickImpactedFund {
  fundId: string;
  fundName: string;
  weightPct: number;
  navImpactPct: number;
}

export interface TickV1 {
  ticker: string;
  name: string;
  price: number;
  changePct: number;
  direction: 'up' | 'down' | 'flat';
  at: string;
  impactedFunds: TickImpactedFund[];
}

interface SeedTicker {
  ticker: string;
  name: string;
  startPrice: number;
}

/**
 * The tradeable universe: twenty names, every one of which appears in the
 * fund book or is selectable in the order form's typeahead.
 *
 * Deliberately small. Everything held by a fund must have a price here or the
 * ticker feed would go quiet on exactly the holdings the drill-down is about;
 * the handful that no fund holds exist so the typeahead has something to
 * filter that is not already on screen.
 */
export const TICKER_UNIVERSE: readonly SeedTicker[] = [
  // Held across the book — TBILL-3M is in every fund (see UNIVERSAL_TICKER).
  { ticker: 'TBILL-3M', name: 'US Treasury Bill 3M', startPrice: 99.42 },
  { ticker: 'AAPL', name: 'Apple Inc.', startPrice: 227.5 },
  { ticker: 'MSFT', name: 'Microsoft Corp.', startPrice: 441.2 },
  { ticker: 'NVDA', name: 'NVIDIA Corp.', startPrice: 128.4 },
  { ticker: 'AMZN', name: 'Amazon.com Inc.', startPrice: 198.7 },
  { ticker: 'JPM', name: 'JPMorgan Chase & Co.', startPrice: 231.6 },
  { ticker: 'EMB-BRZ25', name: 'Brazil Sovereign 2025', startPrice: 96.8 },
  { ticker: 'EMB-MEX28', name: 'Mexico Sovereign 2028', startPrice: 94.1 },
  { ticker: 'EMB-IDN27', name: 'Indonesia Sovereign 2027', startPrice: 97.3 },
  { ticker: 'IG-JPM29', name: 'JPMorgan Chase 4.5% 2029', startPrice: 101.2 },
  { ticker: 'IG-MSFT30', name: 'Microsoft Corp 4.2% 2030', startPrice: 100.6 },
  {
    ticker: 'IG-VZ28',
    name: 'Verizon Communications 4.8% 2028',
    startPrice: 99.1,
  },
  { ticker: 'REIT-AVB', name: 'AvalonBay Communities', startPrice: 214.9 },
  { ticker: 'REIT-PLD', name: 'Prologis Inc.', startPrice: 118.3 },
  { ticker: 'REIT-SPG', name: 'Simon Property Group', startPrice: 172.6 },

  // Not held by any fund — tradeable, so the typeahead can offer them.
  { ticker: 'GOOGL', name: 'Alphabet Inc. Class A', startPrice: 174.3 },
  { ticker: 'META', name: 'Meta Platforms Inc.', startPrice: 592.1 },
  { ticker: 'REIT-O', name: 'Realty Income Corp.', startPrice: 58.2 },
  { ticker: 'TBILL-6M', name: 'US Treasury Bill 6M', startPrice: 98.71 },
  { ticker: 'GILT-2031', name: 'UK Treasury Gilt 2031', startPrice: 92.4 },
];

/**
 * Fund holdings of a ticker, precomputed once — the drill-down data the
 * requirement asks for, derived from the mock book rather than invented per
 * tick.
 */
function holdersOf(
  ticker: string,
): Array<{ fundId: string; fundName: string; weightPct: number }> {
  const holders: Array<{
    fundId: string;
    fundName: string;
    weightPct: number;
  }> = [];
  for (const fund of funds) {
    const holding = fund.holdings.find((h) => h.ticker === ticker);
    if (holding)
      holders.push({
        fundId: fund.id,
        fundName: fund.name,
        weightPct: holding.weightPct,
      });
  }
  return holders;
}

function randomWalk(price: number): { next: number; changePct: number } {
  // A small drift per tick — enough to look alive, not enough to wreck the
  // chart in ten ticks. ±0.6% max per tick.
  const changePct = (Math.random() - 0.5) * 1.2;
  const next = Math.max(0.5, round2(price * (1 + changePct / 100)));
  return { next, changePct: round2(changePct) };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Ticker stream over a plain `ws` `WebSocket.Server` — no socket.io, so
 * neither Angular app needs a client library beyond the native `WebSocket`.
 *
 * Every connection gets its own interval, stopped on disconnect: a per-app
 * demo session is short, but a leaked interval per connection would still
 * degrade a long-running one.
 */
@Injectable()
@WebSocketGateway({ path: '/ws/ticker' })
export class TickerGateway
  implements OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy
{
  private readonly prices = new Map<string, number>(
    TICKER_UNIVERSE.map((s) => [s.ticker, s.startPrice]),
  );
  private readonly holders = new Map(
    TICKER_UNIVERSE.map((s) => [s.ticker, holdersOf(s.ticker)]),
  );
  private readonly timers = new Map<unknown, ReturnType<typeof setInterval>>();

  handleConnection(client: {
    send: (data: string) => void;
    readyState?: number;
  }): void {
    const timer = setInterval(() => this.emitTick(client), 1000);
    this.timers.set(client, timer);
  }

  handleDisconnect(client: unknown): void {
    const timer = this.timers.get(client);
    if (timer) clearInterval(timer);
    this.timers.delete(client);
  }

  onModuleDestroy(): void {
    for (const timer of this.timers.values()) clearInterval(timer);
    this.timers.clear();
  }

  private emitTick(client: {
    send: (data: string) => void;
    readyState?: number;
  }): void {
    // readyState 1 === OPEN. A client mid-close should not throw on send().
    if (client.readyState !== undefined && client.readyState !== 1) return;

    const seed =
      TICKER_UNIVERSE[Math.floor(Math.random() * TICKER_UNIVERSE.length)];
    const current = this.prices.get(seed.ticker) ?? seed.startPrice;
    const { next, changePct } = randomWalk(current);
    this.prices.set(seed.ticker, next);

    const holders = this.holders.get(seed.ticker) ?? [];
    const impactedFunds: TickImpactedFund[] = holders.map((h) => ({
      fundId: h.fundId,
      fundName: h.fundName,
      weightPct: h.weightPct,
      navImpactPct: round2((h.weightPct * changePct) / 100),
    }));

    const tick: TickV1 = {
      ticker: seed.ticker,
      name: seed.name,
      price: next,
      changePct,
      direction: changePct > 0.02 ? 'up' : changePct < -0.02 ? 'down' : 'flat',
      at: new Date().toISOString(),
      impactedFunds,
    };

    client.send(
      JSON.stringify({ event: 'tick', data: { v: 1, payload: tick } }),
    );
  }
}
