/**
 * @skewkit/braid-console — a read-only view of a Braid gateway's fragment registry.
 *
 * Two ways to use it, from one package:
 *
 * ```tsx
 * // as a library, inside an admin app you already run
 * import { RegistryConsole } from '@skewkit/braid-console';
 * <RegistryConsole api={{ baseUrl: '/api/gateway' }} />
 * ```
 *
 * ```sh
 * # as a deployable app — a static bundle pointed at a gateway by config
 * nx build-app braid-console
 * ```
 *
 * It reads the discovery endpoint the gateway already serves, so it needs no snapshot store and
 * no write API — it works against a gateway whose manifests are defined in code.
 */

export { RegistryConsole, filterEntries } from './lib/registry-console.js';
export type { RegistryConsoleProps } from './lib/registry-console.js';
export { RegistryEditor } from './lib/registry-editor.js';
export type { RegistryEditorProps } from './lib/registry-editor.js';
export {
  createDraft,
  draftStatus,
  addFragment,
  removeFragment,
  updateFragment,
  resetDraft,
  parseList,
  formatList,
} from './lib/draft.js';
export type { Draft, DraftStatus } from './lib/draft.js';
export {
  fetchRegistry,
  fetchHead,
  listSnapshots,
  publishSnapshot,
  pinSnapshot,
  RegistryFetchError,
  RegistryApiError,
  DEFAULT_DISCOVERY_PATH,
  DEFAULT_API_PATH,
} from './lib/client.js';
export type { ConsoleApi, RegistryListing, HeadState, PublishOutcome } from './lib/client.js';
export { CONSOLE_STYLES, ensureStyles } from './lib/styles.js';
