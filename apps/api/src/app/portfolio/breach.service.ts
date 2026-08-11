import { Injectable } from '@nestjs/common';
import { UNIVERSAL_TICKER, funds } from './mock-data';

export interface LiquidityBreachV1 {
  id: string;
  at: string;
  severity: 'warning' | 'breach';
  /** The instrument the event is about — always held by every fund. */
  ticker: string;
  trigger: {
    kind: 'order' | 'adjustment' | 'transaction';
    ref: string;
    description: string;
    amount: number;
  };
  impacted: Array<{
    fundId: string;
    fundName: string;
    weightPct: number;
    cashPctBefore: number;
    cashPctAfter: number;
    thresholdPct: number;
  }>;
  suggestedAction: {
    kind: 'raise-cash' | 'sell-holding' | 'defer-redemption';
    ticker: string;
    amount: number;
    rationale: string;
  };
}

const TRIGGER_KINDS: ReadonlyArray<LiquidityBreachV1['trigger']['kind']> = [
  'order',
  'adjustment',
  'transaction',
];

const DESCRIPTIONS: Record<LiquidityBreachV1['trigger']['kind'], string> = {
  order: `Large redemption order forces a partial liquidation of ${UNIVERSAL_TICKER}`,
  adjustment: `Intraday revaluation of ${UNIVERSAL_TICKER} cuts its contribution to cash cover`,
  transaction: `Settlement on ${UNIVERSAL_TICKER} posted late, stranding cash across the book`,
};

let breachCounter = 0;

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pick<T>(arr: readonly T[]): T {
  return arr[randomInt(0, arr.length - 1)];
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Generates a liquidity breach on the one instrument every fund holds.
 *
 * Two decisions here, both to make the event legible rather than realistic:
 *
 * **It always targets `UNIVERSAL_TICKER`, and always impacts every fund.** A
 * breach that hits a random two funds out of the book looks like a bug when
 * the fund you happen to have open is not one of them. Hitting all of them
 * means one button press has a visible consequence everywhere — the fund list,
 * every drill-down, and the open detail panel — which is what makes the
 * relationships between these screens obvious instead of inferred.
 *
 * **It only ever fires on demand.** See `events.controller.ts`.
 */
@Injectable()
export class BreachService {
  generate(): LiquidityBreachV1 {
    breachCounter += 1;
    const kind = pick(TRIGGER_KINDS);
    const severity: LiquidityBreachV1['severity'] =
      Math.random() < 0.65 ? 'breach' : 'warning';

    const impacted = funds.map((fund) => {
      const holding = fund.holdings.find((h) => h.ticker === UNIVERSAL_TICKER);
      const weightPct = holding?.weightPct ?? 0;
      const thresholdPct = 5;
      // The bigger the fund's position in the affected instrument, the harder
      // its cash cover is hit — so the numbers track the holdings on screen
      // rather than being unrelated noise.
      const drop = severity === 'breach' ? weightPct * 0.9 : weightPct * 0.25;
      const after = round2(Math.max(0, fund.cashPct - drop));

      return {
        fundId: fund.id,
        fundName: fund.name,
        weightPct,
        cashPctBefore: fund.cashPct,
        cashPctAfter:
          severity === 'breach' ? Math.min(after, thresholdPct - 0.4) : after,
        thresholdPct,
      };
    });

    const worst = impacted.reduce((a, b) =>
      b.cashPctAfter < a.cashPctAfter ? b : a,
    );
    const shortfall = round2(
      Math.max(0.5, worst.thresholdPct - worst.cashPctAfter),
    );
    const worstFund = funds.find((f) => f.id === worst.fundId);
    if (!worstFund)
      throw new Error(
        `[breach] impacted fund "${worst.fundId}" not found in mock book`,
      );

    const actionKind: LiquidityBreachV1['suggestedAction']['kind'] =
      shortfall > 3 ? 'sell-holding' : 'raise-cash';
    const amount = Math.round((shortfall / 100) * worstFund.nav);

    return {
      id: `LB-${Date.now()}-${breachCounter}`,
      at: new Date().toISOString(),
      severity,
      ticker: UNIVERSAL_TICKER,
      trigger: {
        kind,
        ref: `${kind.slice(0, 3).toUpperCase()}-${randomInt(10000, 99999)}`,
        description: DESCRIPTIONS[kind],
        amount: randomInt(500_000, 12_000_000),
      },
      impacted,
      suggestedAction: {
        kind: actionKind,
        ticker: UNIVERSAL_TICKER,
        amount,
        rationale:
          actionKind === 'sell-holding'
            ? `Sell ~$${Math.round(amount / 1000)}k of ${UNIVERSAL_TICKER} to close the ${shortfall}pt shortfall in ${worst.fundName}.`
            : `Raise ~$${Math.round(amount / 1000)}k of cash to close the ${shortfall}pt shortfall in ${worst.fundName}.`,
      },
    };
  }
}
