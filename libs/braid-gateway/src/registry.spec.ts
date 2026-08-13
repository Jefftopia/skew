import { describe, expect, it } from 'vitest';
import { DEFAULT_ADAPTER, DEFAULT_TIMEOUT_MS, normalizeManifest, Registry } from './registry.js';

describe('normalizeManifest()', () => {
  it('defaults the adapter to compat', () => {
    const resolved = normalizeManifest({ id: 'legacy-billing', endpoint: 'https://billing.internal' });

    expect(DEFAULT_ADAPTER).toBe('compat');
    expect(resolved.adapter).toBe('compat');
    expect(resolved.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
    // a fragment that fails to server-render degrades to the client-side boot path
    expect(resolved.fallback).toBe('placeholder');
  });

  it('keeps a manifest-declared adapter', () => {
    const resolved = normalizeManifest({ id: 'checkout', endpoint: 'https://checkout.internal', adapter: 'react' });
    expect(resolved.adapter).toBe('react');
  });

  it('rejects ids containing a slash (they would break exact namespace addressing)', () => {
    expect(() => normalizeManifest({ id: 'a/b', endpoint: 'https://x.internal' })).toThrow(/invalid/);
    expect(() => normalizeManifest({ id: '', endpoint: 'https://x.internal' })).toThrow(/invalid/);
  });

  it('rejects manifests without an endpoint', () => {
    expect(() => normalizeManifest({ id: 'a', endpoint: undefined as unknown as string })).toThrow(/endpoint/);
  });
});

describe('Registry', () => {
  it('indexes inline manifests by id', async () => {
    const registry = new Registry([
      { id: 'billing', endpoint: 'https://billing.internal' },
      { id: 'checkout', endpoint: 'https://checkout.internal' },
    ]);

    expect((await registry.getFragment('billing'))?.endpoint).toBe('https://billing.internal');
    expect((await registry.getFragment('nope'))).toBeUndefined();
  });

  it('loads manifests from an async loader', async () => {
    const registry = new Registry(async () => [{ id: 'lazy', endpoint: 'https://lazy.internal' }]);
    expect((await registry.getFragment('lazy'))?.adapter).toBe('compat');
  });
});
