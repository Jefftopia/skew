import { Injectable } from '@nestjs/common';
import { funds } from './mock-data';

export interface LiquidityBreachV1 {
  id: string;
  at: string;
  severity: 'warning' | 'breach';
  trigger: {
    kind: 'order' | 'adjustment' | 'transaction';
    ref: string;
    description: string;
    amount: number;
  };
  impacted: Array<{
    fundId: string;
    fundName: string;
    cashPctBefore: number;
    cashPctAfter: number;
    thresholdPct: number;
  }>;
  suggestedAction: {
    kind: 'raise-cash' | 'sell-holding' | 'defer-redemption';
    ticker?: string;
    amount: number;
    rationale: string;
  };
}

const TRIGGER_KINDS: ReadonlyArray<LiquidityBreachV1['trigger']['kind']> = [
  'order',
  'adjustment',
  'transaction',
];

const DESCRIPTIONS: Record<
  LiquidityBreachV1['trigger']['kind'],
  (fundName: string) => string
> = {
  order: (fundName) => `Large redemption order queued against ${fundName}`,
  adjustment: (fundName) => `Intraday NAV adjustment applied to ${fundName}`,
  transaction: (fundName) =>
    `Settlement transaction posted against ${fundName}`,
};

let breachCounter = 0;

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pick<T>(arr: readonly T[]): T {
  return arr[randomInt(0, arr.length - 1)];
}

/**
 * Generates one random liquidity breach against the mock fund book.
 *
 * Deliberately not a Nest-injected singleton with mutable "current state" —
 * each call is a pure roll, so the SSE controller and the debug trigger
 * endpoint (Phase 3, item 3) can share this without coordinating anything.
 */
@Injectable()
export class BreachService {
  generate(): LiquidityBreachV1 {
    breachCounter += 1;
    const kind = pick(TRIGGER_KINDS);
    const trigger = pick(funds);
    const impactedCount = randomInt(1, Math.min(3, funds.length));
    const impactedFunds = shuffle([...funds]).slice(0, impactedCount);

    const severity: LiquidityBreachV1['severity'] =
      Math.random() < 0.6 ? 'breach' : 'warning';

    const impacted = impactedFunds.map((f) => {
      const thresholdPct = f.id === 'f-short-duration-liquidity' ? 15 : 5;
      const drop =
        severity === 'breach'
          ? randomInt(200, 600) / 100
          : randomInt(20, 150) / 100;
      const cashPctAfter = Math.max(0, round2(f.cashPct - drop));
      return {
        fundId: f.id,
        fundName: f.name,
        cashPctBefore: f.cashPct,
        cashPctAfter:
          severity === 'breach'
            ? Math.min(cashPctAfter, thresholdPct - 0.3)
            : cashPctAfter,
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
    const sellCandidate = worstFund.holdings[0];

    const actionKind: LiquidityBreachV1['suggestedAction']['kind'] =
      shortfall > 3
        ? 'sell-holding'
        : Math.random() < 0.5
          ? 'raise-cash'
          : 'defer-redemption';

    return {
      id: `LB-${Date.now()}-${breachCounter}`,
      at: new Date().toISOString(),
      severity,
      trigger: {
        kind,
        ref: `${kind.slice(0, 3).toUpperCase()}-${randomInt(10000, 99999)}`,
        description: DESCRIPTIONS[kind](trigger.name),
        amount: randomInt(500_000, 12_000_000),
      },
      impacted,
      suggestedAction: {
        kind: actionKind,
        ticker:
          actionKind === 'sell-holding' ? sellCandidate?.ticker : undefined,
        amount: Math.round((shortfall / 100) * worstFund.nav),
        rationale:
          actionKind === 'sell-holding'
            ? `Selling ~$${Math.round(((shortfall / 100) * worstFund.nav) / 1000)}k of ${sellCandidate?.name} closes the ${shortfall}pt shortfall in ${worst.fundName}.`
            : actionKind === 'raise-cash'
              ? `Raise cash equal to the ${shortfall}pt shortfall in ${worst.fundName} before end of day.`
              : `Defer redemptions against ${worst.fundName} until cash coverage is restored.`,
      },
    };
  }
}

function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randomInt(0, i);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
