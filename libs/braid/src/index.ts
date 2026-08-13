/**
 * @skewkit/braid — the Braid client runtime.
 *
 * This build ships the compat adapter (C5) as the only — and default — adapter: legacy apps
 * compose as fragments with zero app-code changes, config only.
 *
 * ```ts
 * import { initBraid } from '@skewkit/braid';
 * initBraid();
 * ```
 * ```html
 * <fragment-slot name="checkout"></fragment-slot>
 * ```
 */

import { BraidOptions, setBraidConfig } from './config.js';
import { installAdapter } from './adapters/adapter.js';
import { compatAdapter } from './adapters/compat-adapter.js';
import { FragmentSlot } from './elements/fragment-slot.js';

export { BraidError } from './errors.js';
export type { BraidErrorStage } from './errors.js';
export type { BraidOptions } from './config.js';
export type { FragmentEnv, EnvDocument, EnvLocation, EnvHistory, EnvContext } from './env/fragment-env.js';
export type { BraidAdapter } from './adapters/adapter.js';
export { DEFAULT_ADAPTER } from './adapters/adapter.js';
export { FragmentSlot } from './elements/fragment-slot.js';
export type { FragmentSlotState } from './elements/fragment-slot.js';
export { braidContext } from './context/context-bus.js';
export { createRealm } from './realm/realm-manager.js';
export type { RealmKind, RealmHandle, RealmInit, RealmImportMap } from './realm/realm-manager.js';
export {
  BRAID_FRAGMENT_PREFIX,
  BRAID_REALM_PREFIX,
  BRAID_DOCUMENT_PREFIX,
  BRAID_PROTOCOL_VERSION,
} from './protocol.js';

/**
 * Initializes the Braid client: applies configuration, installs the default compat adapter,
 * and registers the `<fragment-slot>` element. Call once, before any slot connects.
 */
export function initBraid(options: BraidOptions = {}): void {
  setBraidConfig(options);
  installAdapter(compatAdapter);

  if (!customElements.get('fragment-slot')) {
    customElements.define('fragment-slot', FragmentSlot);
  }
}
