import { describe, expect, it } from 'vitest';
import { versionedList } from './list.js';
import { versioned } from './versioned.js';

interface FundV1 {
  id: string;
  currency: string;
}
interface FundV2 {
  id: string;
  baseCurrency: string;
  hqlaPct: number;
}

const Fund = versioned<FundV1>('list-fund').next<FundV2>('rename currency; add hqlaPct', {
  up: (v1) => ({ id: v1.id, baseCurrency: v1.currency, hqlaPct: 0 }),
  down: (v2) => ({ id: v2.id, currency: v2.baseCurrency }),
  derives: ['hqlaPct'],
  lossy: ['hqlaPct'],
});

describe('versionedList', () => {
  it('derives its chain from the item schema — same version, same descriptions', () => {
    const list = versionedList(Fund, 'list-funds');
    expect(list.name).toBe('list-funds');
    expect(list.version).toBe(Fund.version);
    expect(list.steps.map((s) => s.description)).toEqual(Fund.steps.map((s) => s.description));
  });

  it('defaults the name to the item name suffixed with []', () => {
    expect(versionedList(Fund).name).toBe('list-fund[]');
  });

  it('migrates every element exactly as the item schema would', () => {
    const list = versionedList(Fund, 'list-funds');
    const result = list.read({
      v: 1,
      payload: [
        { id: 'a', currency: 'USD' },
        { id: 'b', currency: 'EUR' },
      ],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([
        { id: 'a', baseCurrency: 'USD', hqlaPct: 0 },
        { id: 'b', baseCurrency: 'EUR', hqlaPct: 0 },
      ]);
      expect(result.derivedPaths).toEqual(['[].hqlaPct']);
    }
  });

  it('inherits the down direction, so lists can be written for older readers too', () => {
    const list = versionedList(Fund, 'list-funds');
    const envelope = list.write([{ id: 'a', baseCurrency: 'GBP', hqlaPct: 2 }], { as: 1 });

    expect(envelope.v).toBe(1);
    expect(envelope.payload).toEqual([{ id: 'a', currency: 'GBP' }]);
  });

  it('fails as threw when the payload is not an array at all', () => {
    const list = versionedList(Fund, 'list-funds');
    const result = list.read({ v: 1, payload: { not: 'an array' } });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('threw');
  });
});
