import { afterEach, describe, expect, it } from 'vitest';
import { clearInstalledAdapters, DEFAULT_ADAPTER, installAdapter, resolveAdapter } from './adapter.js';
import { compatAdapter } from './compat-adapter.js';
import { BraidError } from '../errors.js';

afterEach(() => {
  clearInstalledAdapters();
});

describe('adapter resolution', () => {
  it('defaults to the compat adapter when the manifest declares no adapter', () => {
    installAdapter(compatAdapter);

    expect(DEFAULT_ADAPTER).toBe('compat');
    expect(resolveAdapter(null, 'checkout')).toBe(compatAdapter);
    expect(resolveAdapter(undefined, 'checkout')).toBe(compatAdapter);
    expect(resolveAdapter('', 'checkout')).toBe(compatAdapter);
  });

  it('resolves the compat adapter when the manifest declares it explicitly', () => {
    installAdapter(compatAdapter);

    expect(resolveAdapter('compat', 'checkout')).toBe(compatAdapter);
  });

  it('boots compat fragments in compat-http realms', () => {
    expect(compatAdapter.realmKind).toBe('compat-http');
  });

  it('fails with a named adapter-resolution error for adapters not in this build', () => {
    installAdapter(compatAdapter);

    let thrown: unknown;
    try {
      resolveAdapter('react', 'checkout');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(BraidError);
    const braidError = thrown as BraidError;
    expect(braidError.stage).toBe('adapter-resolution');
    expect(braidError.fragmentId).toBe('checkout');
    expect(braidError.fixHint).toContain('compat');
  });

  it('names the missing initBraid() call when no adapter is installed at all', () => {
    let thrown: unknown;
    try {
      resolveAdapter(null, 'checkout');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(BraidError);
    expect((thrown as BraidError).fixHint).toContain('initBraid()');
  });
});
