import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateway } from '@braid/gateway';
import type { FragmentManifest } from '@braid/gateway';
import { createSnapshot } from './snapshot.js';
import { memorySnapshotStore } from './store.js';
import { snapshotRegistry } from './source.js';
import { fileSnapshotStore } from './file-store.js';

/**
 * The integration that matters: a published snapshot is a registry a real gateway serves from.
 * Everything else in this package is bookkeeping in service of this working.
 */
describe('snapshots as a gateway registry', () => {
  const manifests: FragmentManifest[] = [
    { id: 'billing', endpoint: 'https://billing.internal', pierce: ['/billing/*'] },
  ];

  it('serves fragments from a pinned snapshot', async () => {
    const snapshot = await createSnapshot({ manifests });
    const gateway = createGateway({
      mode: 'production',
      registry: snapshotRegistry({ store: memorySnapshotStore([snapshot]), pinned: snapshot.id }),
    });

    // the realm stub is authored by the gateway from the manifest, so a 200 here means the
    // snapshot resolved and the fragment is registered
    const response = await gateway.handle(new Request('https://shell.example/__braid/realm/billing/'));

    expect(response?.status).toBe(200);
    expect(await response?.text()).toContain('billing');
  });

  it('does not know fragments that are not in the pinned snapshot', async () => {
    const snapshot = await createSnapshot({ manifests });
    const gateway = createGateway({
      mode: 'production',
      registry: snapshotRegistry({ store: memorySnapshotStore([snapshot]), pinned: snapshot.id }),
    });

    const response = await gateway.handle(new Request('https://shell.example/__braid/realm/reviews/'));

    expect(response?.status).toBe(404);
  });

  it('round-trips through the filesystem store', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'braid-snapshot-'));
    try {
      const store = fileSnapshotStore({ directory });
      const snapshot = await createSnapshot({ manifests });
      await store.put(snapshot);
      await store.setHead?.(snapshot.id);

      // a fresh store handle, as a restarted process would have
      const gateway = createGateway({
        mode: 'production',
        registry: snapshotRegistry({ store: fileSnapshotStore({ directory }) }),
      });

      const response = await gateway.handle(new Request('https://shell.example/__braid/realm/billing/'));
      expect(response?.status).toBe(200);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('refuses a path-traversal snapshot id rather than reading outside its directory', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'braid-snapshot-'));
    try {
      expect(await fileSnapshotStore({ directory }).get('../../etc/passwd')).toBeNull();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
