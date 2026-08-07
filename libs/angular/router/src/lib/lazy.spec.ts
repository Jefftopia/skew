import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ChunkLoadFailure,
  isChunkLoadFailure,
  lazy,
  lazyDefaults,
  looksLikeChunkError,
  resetLazyDefaults,
} from './lazy';

function chunkError(message = 'Loading chunk 42 failed'): Error {
  const error = new Error(message);
  error.name = 'ChunkLoadError';
  return error;
}

beforeEach(() => resetLazyDefaults());

describe('looksLikeChunkError', () => {
  it.each([
    ['ChunkLoadError by name', chunkError('anything')],
    ['webpack message', new Error('Loading chunk 3 failed')],
    ['vite message', new Error('Failed to fetch dynamically imported module: /x.js')],
    ['rollup message', new Error('error loading dynamically imported module')],
    ['safari message', new Error('Importing a module script failed.')],
  ])('recognises %s', (_label, error) => {
    expect(looksLikeChunkError(error)).toBe(true);
  });

  it('does not claim an ordinary error', () => {
    expect(looksLikeChunkError(new Error('undefined is not a function'))).toBe(false);
    expect(looksLikeChunkError(null)).toBe(false);
  });
});

describe('lazy()', () => {
  it('returns the loaded value when the import succeeds', async () => {
    const load = lazy('admin', async () => 'routes');
    await expect(load()).resolves.toBe('routes');
  });

  it('accepts a bare loader without a module id', async () => {
    const load = lazy(async () => 'routes');
    await expect(load()).resolves.toBe('routes');
  });

  it('retries a transient chunk failure and succeeds', async () => {
    let calls = 0;
    const load = lazy(
      'admin',
      async () => {
        if (++calls === 1) throw chunkError();
        return 'routes';
      },
      { retryDelayMs: 0 },
    );

    await expect(load()).resolves.toBe('routes');
    expect(calls).toBe(2);
  });

  it('throws ChunkLoadFailure once retries are exhausted', async () => {
    const loader = vi.fn(async () => {
      throw chunkError();
    });
    const load = lazy('admin.routes', loader, { retryAttempts: 2, retryDelayMs: 0 });

    await expect(load()).rejects.toBeInstanceOf(ChunkLoadFailure);
    expect(loader).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it('carries the module id across the failure boundary', async () => {
    const load = lazy('admin.routes', async () => {
      throw chunkError();
    }, { retryAttempts: 0 });

    await load().catch((error: unknown) => {
      expect(isChunkLoadFailure(error)).toBe(true);
      if (isChunkLoadFailure(error)) {
        expect(error.moduleId).toBe('admin.routes');
        expect(error.attempts).toBe(1);
        expect(error.message).toContain('admin.routes');
      }
    });
    expect.assertions(4);
  });

  it('does not retry an error thrown by module evaluation', async () => {
    // Retrying a genuine bug just runs the bug again — and, worse, delays the
    // real stack trace behind a recovery attempt.
    const loader = vi.fn(async () => {
      throw new TypeError('cannot read properties of undefined');
    });
    const load = lazy('admin', loader, { retryAttempts: 3, retryDelayMs: 0 });

    await expect(load()).rejects.toBeInstanceOf(TypeError);
    expect(loader).toHaveBeenCalledOnce();
  });

  it('honours globally published defaults', async () => {
    lazyDefaults.retryAttempts = 2;
    lazyDefaults.retryDelayMs = 0;
    const loader = vi.fn(async () => {
      throw chunkError();
    });

    await lazy('admin', loader)().catch(() => undefined);

    expect(loader).toHaveBeenCalledTimes(3);
  });

  it('lets a per-call option beat the global default', async () => {
    lazyDefaults.retryAttempts = 5;
    lazyDefaults.retryDelayMs = 0;
    const loader = vi.fn(async () => {
      throw chunkError();
    });

    await lazy('admin', loader, { retryAttempts: 0 })().catch(() => undefined);

    expect(loader).toHaveBeenCalledOnce();
  });

  it('rejects a missing loader loudly at definition time', () => {
    expect(() => lazy('admin', undefined as never)).toThrow(TypeError);
  });
});
