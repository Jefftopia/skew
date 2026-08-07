import { initFederation } from '@angular-architects/native-federation';

/**
 * The remote initialises federation against *itself*, so that running
 * standalone goes through the same import-map path as being consumed by a host.
 * A remote that only works when embedded is a remote nobody can debug.
 */
initFederation({ 'prod-remote': './remoteEntry.json' })
  .catch((err) => console.error('[federation] init failed', err))
  .then(() => import('./bootstrap'))
  .catch((err) => console.error('[federation] bootstrap failed', err));
