import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetSchemaRegistry, versioned } from '@braid/skew';
import { contractFingerprint } from './document.js';
import { createContractResolver } from './resolver.js';
import { FUND_CONTRACT } from './document.spec.js';

const CONTRACT_URL = 'http://api.test/.well-known/skew/contracts/portfolio-fund';

function jsonResponse(body: unknown, init: { status?: number; etag?: string } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: init.etag ? { etag: init.etag, 'content-type': 'application/json' } : { 'content-type': 'application/json' },
  });
}

afterEach(() => resetSchemaRegistry());

describe('createContractResolver', () => {
  it('fetches, validates, and caches a document', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(FUND_CONTRACT, { etag: '"abc"' }));
    const resolver = createContractResolver({ fetchImpl });

    const doc = await resolver.resolve(CONTRACT_URL);
    expect(doc.name).toBe('portfolio-fund');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('revalidates with If-None-Match and keeps the cached copy on 304', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(FUND_CONTRACT, { etag: '"abc"' }))
      .mockResolvedValueOnce(new Response(null, { status: 304 }));
    const resolver = createContractResolver({ fetchImpl });

    await resolver.resolve(CONTRACT_URL);
    const again = await resolver.resolve(CONTRACT_URL); // revalidates, no invalidation

    expect(again.name).toBe('portfolio-fund');
    const secondCall = fetchImpl.mock.calls[1] as [string, { headers: Record<string, string> }];
    expect(secondCall[1].headers['if-none-match']).toBe('"abc"');
  });

  it('serves the cached copy when the origin becomes unreachable', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(FUND_CONTRACT))
      .mockRejectedValueOnce(new Error('offline'));
    const resolver = createContractResolver({ fetchImpl });

    await resolver.resolve(CONTRACT_URL);
    await expect(resolver.resolve(CONTRACT_URL)).resolves.toMatchObject({ name: 'portfolio-fund' });
  });

  it('rejects a malformed document at the boundary', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ nonsense: true }));
    const resolver = createContractResolver({ fetchImpl });

    await expect(resolver.resolve(CONTRACT_URL)).rejects.toThrow(/skew contract/);
  });

  it('refuses a document whose fingerprint moved off the pin', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(FUND_CONTRACT));
    const resolver = createContractResolver({
      fetchImpl,
      pinnedFingerprints: { [CONTRACT_URL]: 'ffffffff' },
    });

    await expect(resolver.resolve(CONTRACT_URL)).rejects.toThrow(/pins ffffffff/);
  });

  it('accepts a document matching its pin', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(FUND_CONTRACT));
    const resolver = createContractResolver({
      fetchImpl,
      pinnedFingerprints: { [CONTRACT_URL]: contractFingerprint(FUND_CONTRACT) },
    });

    await expect(resolver.resolve(CONTRACT_URL)).resolves.toBeTruthy();
  });

  it('deduplicates concurrent resolves of the same URL', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(FUND_CONTRACT));
    const resolver = createContractResolver({ fetchImpl });

    await Promise.all([resolver.resolve(CONTRACT_URL), resolver.resolve(CONTRACT_URL)]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('readResolving — the ahead cure, end to end', () => {
  // The host: a v1-only build. It shipped before v2 existed; nothing in its
  // bundle knows the newer shape.
  interface FundV1 {
    id: string;
    currency: string;
    nav: number;
  }

  const v2Record = {
    v: 2,
    payload: {
      id: 'f1',
      baseCurrency: 'EUR',
      nav: { amount: 250, asOf: '2026-08-01T00:00:00.000Z' },
      liquidity: { cashPct: 3, hqlaPct: 61, redemptionCoverDays: 12 },
      classification: { assetClass: 'fixed-income', strategy: 'short-duration' },
      holdings: [],
    },
  };

  it('turns ahead into an honest downgrade by resolving the contract from the origin', async () => {
    const host = versioned<FundV1>('portfolio-fund');
    expect(host.read(v2Record).ok).toBe(false); // the dead end, before

    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(FUND_CONTRACT));
    const resolver = createContractResolver({ fetchImpl });

    const result = await resolver.readResolving(host, v2Record, CONTRACT_URL);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.downgradedFrom).toBe(2);
      expect(result.value).toMatchObject({ id: 'f1', currency: 'EUR', nav: 250 });
      expect(result.lossyPaths.length).toBeGreaterThan(0);
    }
  });

  it('passes non-ahead results through without fetching anything', async () => {
    const host = versioned<FundV1>('portfolio-fund');
    const fetchImpl = vi.fn();
    const resolver = createContractResolver({ fetchImpl });

    const result = await resolver.readResolving(host, { v: 1, payload: { id: 'f1', currency: 'USD', nav: 1 } }, CONTRACT_URL);

    expect(result.ok).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('lifts the item contract to a declared list schema — a v1 host reads a v2 fund list', async () => {
    const hostList = versioned<FundV1[]>('portfolio-funds');
    const v2List = { v: 2, payload: [v2Record.payload] };
    expect(hostList.read(v2List).ok).toBe(false); // ahead, before

    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(FUND_CONTRACT));
    const resolver = createContractResolver({
      fetchImpl,
      lists: { 'portfolio-fund': 'portfolio-funds' },
    });

    const result = await resolver.readResolving(hostList, v2List, CONTRACT_URL);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.downgradedFrom).toBe(2);
      expect(result.value).toEqual([expect.objectContaining({ id: 'f1', currency: 'EUR', nav: 250 })]);
      expect(result.lossyPaths.every((path) => path.startsWith('[].'))).toBe(true);
    }
  });

  it('returns the original refusal when the contract cannot be resolved', async () => {
    const host = versioned<FundV1>('portfolio-fund');
    const fetchImpl = vi.fn().mockRejectedValue(new Error('offline'));
    const resolver = createContractResolver({ fetchImpl });

    const result = await resolver.readResolving(host, v2Record, CONTRACT_URL);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('ahead');
  });
});
