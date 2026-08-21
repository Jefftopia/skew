import { describe, expect, it, vi } from 'vitest';
import type { FragmentManifest } from '@braidlabs/gateway';
import { createSnapshot } from './snapshot.js';
import { memorySnapshotStore } from './store.js';
import type { SnapshotStore } from './store.js';
import { snapshotRegistry } from './source.js';
import type { SnapshotDiagnostic } from './source.js';

const manifests: FragmentManifest[] = [{ id: 'billing', endpoint: 'https://billing.internal' }];

/** A store that always fails, standing in for one that is down at boot. */
function brokenStore(): SnapshotStore {
  return {
    async get() {
      throw new Error('connection refused');
    },
    async put() {
      throw new Error('connection refused');
    },
    async list() {
      throw new Error('connection refused');
    },
  };
}

describe('snapshotRegistry', () => {
  it('serves the pinned snapshot', async () => {
    const snapshot = await createSnapshot({ manifests });
    const store = memorySnapshotStore([snapshot]);

    const source = snapshotRegistry({ store, pinned: snapshot.id });

    expect(await source()).toEqual(manifests);
  });

  it('follows the store head when nothing is pinned', async () => {
    const snapshot = await createSnapshot({ manifests });
    const store = memorySnapshotStore([snapshot]);
    const diagnostics: SnapshotDiagnostic[] = [];

    const source = snapshotRegistry({ store, onDiagnostic: (d) => diagnostics.push(d) });

    expect(await source()).toEqual(manifests);
    expect(diagnostics.map((d) => d.event)).toContain('head-followed');
  });

  it('explains itself when nothing is pinned and the store has no head', async () => {
    const source = snapshotRegistry({ store: memorySnapshotStore() });

    await expect(source()).rejects.toThrow(/no snapshot pinned/);
  });

  it('refuses a snapshot whose content does not match its id', async () => {
    const snapshot = await createSnapshot({ manifests });
    const store = memorySnapshotStore([
      { ...snapshot, manifests: [{ id: 'billing', endpoint: 'https://attacker.example' }] },
    ]);

    const source = snapshotRegistry({ store, pinned: snapshot.id });

    await expect(source()).rejects.toThrow(/failed content verification/);
  });

  it('writes through to the cache on a successful resolve', async () => {
    const snapshot = await createSnapshot({ manifests });
    const cache = memorySnapshotStore();

    await snapshotRegistry({ store: memorySnapshotStore([snapshot]), pinned: snapshot.id, cache })();
    await vi.waitFor(async () => expect(await cache.get(snapshot.id)).not.toBeNull());
  });

  it('serves the cached snapshot when the store is unreachable', async () => {
    const snapshot = await createSnapshot({ manifests });
    const cache = memorySnapshotStore([snapshot]);
    const diagnostics: SnapshotDiagnostic[] = [];

    const source = snapshotRegistry({
      store: brokenStore(),
      pinned: snapshot.id,
      cache,
      onDiagnostic: (d) => diagnostics.push(d),
    });

    expect(await source()).toEqual(manifests);
    expect(diagnostics.find((d) => d.event === 'served-from-cache')?.level).toBe('warn');
  });

  it('does not fall back when the caller asked it not to', async () => {
    const snapshot = await createSnapshot({ manifests });

    const source = snapshotRegistry({
      store: brokenStore(),
      pinned: snapshot.id,
      cache: memorySnapshotStore([snapshot]),
      fallback: 'fail',
    });

    await expect(source()).rejects.toThrow(/connection refused/);
  });

  it('does not serve a cached snapshot that has been altered', async () => {
    const snapshot = await createSnapshot({ manifests });
    const cache = memorySnapshotStore([
      { ...snapshot, manifests: [{ id: 'billing', endpoint: 'https://attacker.example' }] },
    ]);

    const source = snapshotRegistry({ store: brokenStore(), pinned: snapshot.id, cache });

    await expect(source()).rejects.toThrow(/failed content verification/);
  });

  it('survives a cache it cannot write to', async () => {
    const snapshot = await createSnapshot({ manifests });
    const diagnostics: SnapshotDiagnostic[] = [];

    const source = snapshotRegistry({
      store: memorySnapshotStore([snapshot]),
      pinned: snapshot.id,
      cache: brokenStore(),
      onDiagnostic: (d) => diagnostics.push(d),
    });

    expect(await source()).toEqual(manifests);
    await vi.waitFor(() => expect(diagnostics.some((d) => d.event === 'cache-write-failed')).toBe(true));
  });
});
