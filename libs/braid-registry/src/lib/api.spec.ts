import { describe, expect, it, vi } from 'vitest';
import type { FragmentManifest } from '@braidlabs/gateway';
import { createRegistryApi } from './api.js';
import { memorySnapshotStore } from './store.js';
import { createSnapshot } from './snapshot.js';

const BASE = 'https://ops.example/__braid/registry-api';
const manifests: FragmentManifest[] = [{ id: 'billing', endpoint: 'https://billing.internal', pierce: ['/billing/*'] }];

const post = (path: string, body: unknown) =>
  new Request(`${BASE}${path}`, { method: 'POST', body: JSON.stringify(body) });

const allow = () => true;

describe('registry write API', () => {
  it('ignores requests outside its base path', async () => {
    const api = createRegistryApi({ store: memorySnapshotStore(), authorize: allow });

    expect(await api.handle(new Request('https://ops.example/anything'))).toBeNull();
  });

  describe('authorization', () => {
    it('refuses writes when no authorize hook is configured', async () => {
      const api = createRegistryApi({ store: memorySnapshotStore() });

      const response = await api.handle(post('/snapshots', { manifests }));

      expect(response?.status).toBe(403);
      expect((await response!.json()).error).toMatch(/no `authorize` hook/);
    });

    it('still allows reads without one, matching the registry’s public-by-default posture', async () => {
      const api = createRegistryApi({ store: memorySnapshotStore() });

      expect((await api.handle(new Request(`${BASE}/snapshots`)))?.status).toBe(200);
    });

    it('refuses when the hook says no', async () => {
      const api = createRegistryApi({ store: memorySnapshotStore(), authorize: () => false });

      expect((await api.handle(post('/snapshots', { manifests })))?.status).toBe(403);
    });

    it('tells the hook which action is being attempted', async () => {
      const authorize = vi.fn(() => true);
      const api = createRegistryApi({ store: memorySnapshotStore(), authorize });

      await api.handle(new Request(`${BASE}/snapshots`));
      await api.handle(post('/snapshots', { manifests }));

      expect(authorize.mock.calls.map((call) => (call as unknown as [Request, string])[1])).toEqual([
        'read',
        'publish',
      ]);
    });
  });

  describe('publish', () => {
    it('mints, stores, and pins', async () => {
      const store = memorySnapshotStore();
      const api = createRegistryApi({ store, authorize: allow });

      const response = await api.handle(post('/snapshots', { manifests }));
      const result = await response?.json();

      expect(response?.status).toBe(201);
      expect(result.snapshot.id).toMatch(/^reg_/);
      expect(result.pinned).toBe(true);
      expect(await store.head?.()).toBe(result.snapshot.id);
    });

    it('can publish without pinning, so a snapshot can be prepared before it is used', async () => {
      const store = memorySnapshotStore();
      const api = createRegistryApi({ store, authorize: allow });

      const result = await (await api.handle(post('/snapshots', { manifests, pin: false })))?.json();

      expect(result.pinned).toBe(false);
      expect(await store.head?.()).toBeNull();
    });

    it('refuses a registry with errors and writes nothing', async () => {
      const store = memorySnapshotStore();
      const api = createRegistryApi({ store, authorize: allow });

      const response = await api.handle(post('/snapshots', { manifests: [{ id: 'x', endpoint: '/relative' }] }));

      expect(response?.status).toBe(422);
      expect((await response!.json()).findings[0].code).toBe('invalid-endpoint');
      expect(await store.list()).toEqual([]);
    });

    it('validates server-side even when a client did not', async () => {
      // the console validates as you type because that is good to use, not because it is trusted
      const api = createRegistryApi({ store: memorySnapshotStore(), authorize: allow });

      const response = await api.handle(
        post('/snapshots', { manifests: [{ id: 'a/b', endpoint: 'https://x.internal' }] }),
      );

      expect(response?.status).toBe(422);
    });

    it('returns warnings alongside a successful publish', async () => {
      const api = createRegistryApi({ store: memorySnapshotStore(), authorize: allow });

      const result = await (
        await api.handle(
          post('/snapshots', {
            manifests: [
              { id: 'a', endpoint: 'https://a.internal', pierce: ['/*'] },
              { id: 'b', endpoint: 'https://b.internal', pierce: ['/billing/*'] },
            ],
          }),
        )
      )?.json();

      expect(result.findings[0].code).toBe('pierce-overlap');
      expect(result.snapshot.id).toMatch(/^reg_/);
    });

    it('reports what the new snapshot changes about the pinned one', async () => {
      const store = memorySnapshotStore();
      const api = createRegistryApi({ store, authorize: allow });
      await api.handle(post('/snapshots', { manifests }));

      const result = await (
        await api.handle(
          post('/snapshots', { manifests: [...manifests, { id: 'reviews', endpoint: 'https://r.internal' }] }),
        )
      )?.json();

      expect(result.diff.added.map((m: FragmentManifest) => m.id)).toEqual(['reviews']);
    });

    it('rejects a body that is not a manifest list', async () => {
      const api = createRegistryApi({ store: memorySnapshotStore(), authorize: allow });

      expect((await api.handle(post('/snapshots', { nope: true })))?.status).toBe(400);
    });

    it('merges descriptors when configured to probe', async () => {
      const fetchMock = vi.fn(
        async () =>
          new Response(JSON.stringify({ title: 'Billing from the app' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      );
      const store = memorySnapshotStore();
      const api = createRegistryApi({
        store,
        authorize: allow,
        fetchDescriptors: true,
        fetch: fetchMock as unknown as typeof fetch,
      });

      const result = await (await api.handle(post('/snapshots', { manifests })))?.json();
      const snapshot = await store.get(result.snapshot.id);

      expect(snapshot?.manifests[0]?.title).toBe('Billing from the app');
      expect(result.descriptorNotes[0]).toMatchObject({ kind: 'applied', field: 'title' });
    });

    it('does not probe unless asked', async () => {
      const fetchMock = vi.fn();
      const api = createRegistryApi({
        store: memorySnapshotStore(),
        authorize: allow,
        fetch: fetchMock as unknown as typeof fetch,
      });

      await api.handle(post('/snapshots', { manifests }));

      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('read and pin', () => {
    it('lists snapshots with the current head', async () => {
      const snapshot = await createSnapshot({ manifests });
      const store = memorySnapshotStore([snapshot]);
      await store.setHead?.(snapshot.id);
      const api = createRegistryApi({ store, authorize: allow });

      const body = await (await api.handle(new Request(`${BASE}/snapshots`)))?.json();

      expect(body.items[0].id).toBe(snapshot.id);
      expect(body.head).toBe(snapshot.id);
    });

    it('serves a snapshot by id and 404s an unknown one', async () => {
      const snapshot = await createSnapshot({ manifests });
      const api = createRegistryApi({ store: memorySnapshotStore([snapshot]), authorize: allow });

      expect((await api.handle(new Request(`${BASE}/snapshots/${snapshot.id}`)))?.status).toBe(200);
      expect((await api.handle(new Request(`${BASE}/snapshots/reg_missing`)))?.status).toBe(404);
    });

    it('re-pins to an existing snapshot', async () => {
      const first = await createSnapshot({ manifests });
      const second = await createSnapshot({ manifests: [...manifests, { id: 'r', endpoint: 'https://r.internal' }] });
      const store = memorySnapshotStore([first, second]);
      const api = createRegistryApi({ store, authorize: allow });

      // rollback is a pointer move: no inverse migration, no undo log
      expect((await api.handle(post('/head', { id: first.id })))?.status).toBe(200);
      expect(await store.head?.()).toBe(first.id);
    });

    it('refuses to pin a snapshot that is not stored', async () => {
      const api = createRegistryApi({ store: memorySnapshotStore(), authorize: allow });

      const response = await api.handle(post('/head', { id: 'reg_nope' }));

      expect(response?.status).toBe(404);
      expect((await response!.json()).error).toMatch(/cannot pin what is not stored/);
    });
  });
});
