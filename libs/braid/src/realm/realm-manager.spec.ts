import { describe, expect, it } from 'vitest';
import { createRealm, RealmKind } from './realm-manager.js';
import { BraidError } from '../errors.js';

const init = () => ({
  fragmentId: 'checkout',
  routeUrl: '/checkout',
  bound: false,
  signal: new AbortController().signal,
});

describe('createRealm()', () => {
  it('rejects the untrusted sandbox tier with a named error', async () => {
    const error = await createRealm('sandbox', init()).catch((thrown) => thrown);

    expect(error).toBeInstanceOf(BraidError);
    expect((error as BraidError).stage).toBe('realm-boot');
    expect((error as BraidError).fixHint).toContain('trusted');
  });

  it('rejects an unknown realm kind with a named error', async () => {
    const error = await createRealm('worker' as RealmKind, init()).catch((thrown) => thrown);

    expect(error).toBeInstanceOf(BraidError);
    expect((error as BraidError).message).toContain('unknown realm kind');
  });

  it('refuses a compat realm for a cross-origin route url', async () => {
    const error = await createRealm('compat-http', { ...init(), routeUrl: 'https://elsewhere.example/x' }).catch(
      (thrown) => thrown,
    );

    expect(error).toBeInstanceOf(BraidError);
    expect((error as BraidError).stage).toBe('realm-boot');
    expect((error as BraidError).message).toContain('same-origin');
  });
});
