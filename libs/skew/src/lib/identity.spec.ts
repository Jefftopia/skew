import { describe, expect, it, vi } from 'vitest';
import { compareBuilds, createVersionProbe, moduleWasRemoved } from './identity.js';

const local = { buildId: 'b1', builtAt: '2026-08-01T00:00:00Z' };

describe('compareBuilds', () => {
  it('reports current when identities match', () => {
    const status = compareBuilds(local, { buildId: 'b1' });
    expect(status.kind).toBe('current');
  });

  it('reports a stale client when the origin is newer', () => {
    const status = compareBuilds(local, { buildId: 'b2', builtAt: '2026-08-02T00:00:00Z' });
    expect(status.kind).toBe('staleClient');
    if (status.kind === 'staleClient') {
      expect(status.remote).toBe('b2');
      expect(status.remoteBuiltAt).toBe('2026-08-02T00:00:00Z');
    }
  });

  it('reports a stale origin when the origin is older — the reload-loop case', () => {
    const status = compareBuilds(local, { buildId: 'b0', builtAt: '2026-07-01T00:00:00Z' });
    expect(status.kind).toBe('staleOrigin');
  });

  it('falls back to differs when builds cannot be ordered', () => {
    const status = compareBuilds({ buildId: 'b1' }, { buildId: 'b2' });
    expect(status.kind).toBe('differs');
  });

  it('treats an unparseable timestamp as unorderable rather than guessing', () => {
    const status = compareBuilds(local, { buildId: 'b2', builtAt: 'not-a-date' });
    expect(status.kind).toBe('differs');
  });
});

describe('createVersionProbe', () => {
  const manifest = { buildId: 'b2', builtAt: '2026-08-02T00:00:00Z' };
  const okResponse = () =>
    ({ ok: true, status: 200, json: async () => manifest }) as unknown as Response;

  it('fetches the manifest and classifies', async () => {
    const fetchImpl = vi.fn(async () => okResponse());
    const probe = createVersionProbe({ identity: local, manifestUrl: '/m.json', fetch: fetchImpl });

    const status = await probe.check();

    expect(status.kind).toBe('staleClient');
    expect(fetchImpl).toHaveBeenCalledWith('/m.json', expect.objectContaining({ cache: 'no-store' }));
  });

  it('reuses the cached answer inside the interval', async () => {
    const fetchImpl = vi.fn(async () => okResponse());
    const probe = createVersionProbe({
      identity: local,
      manifestUrl: '/m.json',
      fetch: fetchImpl,
      minIntervalMs: 60_000,
    });

    await probe.check();
    await probe.check();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(probe.last()?.kind).toBe('staleClient');
  });

  it('collapses concurrent callers onto a single request', async () => {
    const fetchImpl = vi.fn(async () => okResponse());
    const probe = createVersionProbe({ identity: local, manifestUrl: '/m.json', fetch: fetchImpl });

    await Promise.all([probe.check(), probe.check(), probe.check()]);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('re-probes after invalidate', async () => {
    const fetchImpl = vi.fn(async () => okResponse());
    const probe = createVersionProbe({
      identity: local,
      manifestUrl: '/m.json',
      fetch: fetchImpl,
      minIntervalMs: 60_000,
    });

    await probe.check();
    probe.invalidate();
    await probe.check();

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('reports unreachable rather than throwing when offline', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down');
    });
    const probe = createVersionProbe({ identity: local, manifestUrl: '/m.json', fetch: fetchImpl });

    const status = await probe.check();

    expect(status.kind).toBe('unreachable');
  });

  it('reports unreachable on a non-ok response', async () => {
    const fetchImpl = vi.fn(
      async () => ({ ok: false, status: 503 }) as unknown as Response,
    );
    const probe = createVersionProbe({ identity: local, manifestUrl: '/m.json', fetch: fetchImpl });

    const status = await probe.check();

    expect(status.kind).toBe('unreachable');
    if (status.kind === 'unreachable') {
      expect(String((status.error as Error).message)).toContain('503');
    }
  });
});

describe('moduleWasRemoved', () => {
  it('is false when the manifest carries no module map', () => {
    expect(moduleWasRemoved({ buildId: 'b' }, 'admin')).toBe(false);
  });

  it('detects a deleted module', () => {
    const manifest = { buildId: 'b', modules: { home: { file: 'home-abc.js' } } };
    expect(moduleWasRemoved(manifest, 'admin')).toBe(true);
    expect(moduleWasRemoved(manifest, 'home')).toBe(false);
  });
});
