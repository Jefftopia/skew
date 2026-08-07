import { initFederation } from '@angular-architects/native-federation';

/**
 * Federation is initialised *before* Angular boots.
 *
 * `initFederation` fetches the manifest, resolves every remote's
 * `remoteEntry.json`, and installs the import map the browser will use for the
 * rest of the page's life. That has to finish first, which is why bootstrapping
 * lives in a separate module reached by dynamic import rather than in this file.
 *
 * The import map is the thing that goes stale: it is resolved once, here, and
 * points at hashed file names that a later deployment of the remote will delete.
 */
initFederation('federation.manifest.json')
  .catch((err) => console.error('[federation] init failed', err))
  .then(() => import('./bootstrap'))
  .catch((err) => console.error('[federation] bootstrap failed', err));
