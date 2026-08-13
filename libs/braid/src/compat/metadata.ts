/**
 * Per-fragment metadata the compat adapter attaches to the fragment's shadow root.
 *
 * The virtualized `document.readyState` can't be delegated to either document (the fragment
 * needs its own lifecycle), so the adapter manages it here and the document facade reads it.
 */

export interface CompatMetadata {
  documentReadyState: DocumentReadyState;
}

export const compatMetadataSymbol = Symbol('braid-compat:metadata');

export type CompatShadowRoot = ShadowRoot & {
  [compatMetadataSymbol]: CompatMetadata;
};

/** Internal-reference bookkeeping: native members captured before facade/patch installation. */
const compatReferencesSymbol = Symbol('braid-compat:references');

export function setInternalReference<T extends object>(target: T, key: keyof T) {
  (target as any)[compatReferencesSymbol] ??= {};
  (target as any)[compatReferencesSymbol][key] = Reflect.get(target, key);
}

export function getInternalReference<T extends object, K extends keyof T>(target: T, key: K): T[K] {
  const references = (target as any)[compatReferencesSymbol];
  if (!references || references[key] === undefined) {
    throw new Error(`Attempted to access internal reference "${String(key)}" before it was set.`);
  }

  return references[key];
}
