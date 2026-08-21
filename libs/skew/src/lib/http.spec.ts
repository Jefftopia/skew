import { describe, expect, it } from 'vitest';
import {
  envelopeFromResponse,
  formatSkewContractHeader,
  parseSkewContractHeader,
  versionFromResponse,
} from './http.js';
import { versioned } from './versioned.js';

function response(headers: Record<string, string>, url?: string) {
  const table = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { url, headers: { get: (name: string) => table.get(name.toLowerCase()) ?? null } };
}

describe('parseSkewContractHeader', () => {
  it('parses a bare version', () => {
    expect(parseSkewContractHeader('2')).toEqual({ v: 2 });
  });

  it('parses a named contract with a version', () => {
    expect(parseSkewContractHeader('portfolio-fund; v=2')).toEqual({ name: 'portfolio-fund', v: 2 });
  });

  it('parses a linked contract document', () => {
    expect(parseSkewContractHeader('</.well-known/skew/contracts/portfolio-fund>; v=2')).toEqual({
      url: '/.well-known/skew/contracts/portfolio-fund',
      v: 2,
    });
  });

  it('round-trips through the formatter', () => {
    const ref = { url: '/.well-known/skew/contracts/fund', v: 3 };
    expect(parseSkewContractHeader(formatSkewContractHeader(ref))).toEqual(ref);
  });
});

describe('versionFromResponse', () => {
  it('prefers the skew-contract header', () => {
    const res = response({ 'skew-contract': 'fund; v=2' }, 'http://api/v1/funds');
    expect(versionFromResponse(res)).toBe(2);
  });

  it('falls back to the media type', () => {
    const res = response({ 'content-type': 'application/vnd.acme.fund.v3+json' });
    expect(versionFromResponse(res)).toBe(3);
  });

  it('falls back to the URL', () => {
    expect(versionFromResponse(response({}, 'http://api/v2/funds?page=1'))).toBe(2);
    expect(versionFromResponse(response({}, 'http://api/v2/funds/abc'))).toBe(2);
  });

  it('returns null when nothing carries a version', () => {
    expect(versionFromResponse(response({}, 'http://api/funds'))).toBeNull();
  });
});

describe('envelopeFromResponse', () => {
  interface FundV1 {
    id: string;
  }
  interface FundV2 {
    id: string;
    baseCurrency: string;
  }
  const schema = versioned<FundV1>('http-fund').next<FundV2>('add baseCurrency', {
    up: (v1) => ({ ...v1, baseCurrency: 'USD' }),
    down: ({ baseCurrency: _dropped, ...rest }) => rest,
    derives: ['baseCurrency'],
  });

  it('wraps a bare body at the version the response carries — no body envelope needed', () => {
    const res = response({}, 'http://api/v1/funds/f1');
    const result = schema.read(envelopeFromResponse(res, { id: 'f1' }));

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.migratedFrom).toBe(1);
  });

  it('leaves an already-enveloped body alone — the writer knows best', () => {
    const res = response({}, 'http://api/v9/funds/f1'); // lying URL
    const normalized = envelopeFromResponse(res, { v: 2, payload: { id: 'f1', baseCurrency: 'EUR' } });

    const result = schema.read(normalized);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.migratedFrom).toBeNull();
  });

  it('passes a bare body through untouched when no version is found', () => {
    const body = { id: 'f1' };
    expect(envelopeFromResponse(response({}, 'http://api/funds'), body)).toBe(body);
  });
});
