import { documentSurface } from './document-surface.generated.js';
import { documentMemberClassification } from './document-member-classification.js';
import { isDevMode } from '../config.js';

/**
 * A facade override for a single Document member, mirroring the shape of a property descriptor:
 * either an accessor (`get`, optionally with `set`) or a data member (`value`, typically a method).
 */
export type FacadeOverride =
  | { get: () => unknown; set?: (value: any) => void; value?: never }
  | { value: unknown; get?: never; set?: never };

export type FacadeOverrides = Record<string, FacadeOverride>;

/**
 * Members inherited by Document from these interfaces always pass through to the realm document
 * silently. DOM tree traversal and event dispatch are virtualized at other layers (the fragment
 * boundary and the event system patches in `realm-patches.ts`).
 */
const inheritedInterfaces = new Set(['Node', 'EventTarget']);

let lazyUnauditedDocumentMembers: Set<string> | undefined;

/**
 * Returns whether the given member is a spec-defined Document member that has not been audited
 * for compat fragment contexts yet. Access to such members falls through to the realm document
 * and triggers a dev-mode diagnostic.
 */
function isUnauditedDocumentMember(name: string): boolean {
  lazyUnauditedDocumentMembers ??= new Set(
    Object.keys(documentSurface).filter(
      (member) => !(member in documentMemberClassification) && !inheritedInterfaces.has(documentSurface[member].from),
    ),
  );
  return lazyUnauditedDocumentMembers.has(name);
}

/**
 * Installs a virtualizing facade over the given realm document by splicing a Proxy into its
 * prototype chain.
 *
 * The proxy classifies every property access on the document:
 *
 * - members with an override (classified `'virtualized'`) are redirected to the override, which
 *   operates on the fragment's DOM in the main document,
 * - members classified `'native'` pass through to the realm document's native behavior,
 * - spec-defined Document members that are not classified also pass through, but log a one-time
 *   dev-mode diagnostic so that unaudited API usage by fragments surfaces during development
 *   instead of silently misbehaving,
 * - anything else (application-defined expandos, symbols) passes through silently.
 *
 * Unlike patching individual properties, the proxy guarantees that *every* property access is
 * observed, which turns "we forgot to patch X" from a silent wrong-document bug into an
 * actionable diagnostic.
 *
 * Note that unlike `window` (whose prototype is immutable per the HTML spec), a Document
 * instance has an ordinary, mutable [[Prototype]] slot, so splicing is safe cross-browser. Own
 * properties of the document instance (e.g. the [LegacyUnforgeable] `location`) are unaffected.
 *
 * This patches the fragment's own realm document only — never the host
 * page's document.
 *
 * @param realmDocument the fragment's realm iframe document to install the facade on
 * @param overrides the virtualized member implementations (see `createDocumentOverrides`)
 * @returns a function that uninstalls the facade and restores the original prototype chain
 */
export function installDocumentFacade(realmDocument: Document, overrides: FacadeOverrides): () => void {
  const originalPrototype = Object.getPrototypeOf(realmDocument);
  const overrideMap = new Map<string, FacadeOverride>(Object.entries(overrides));
  const warnedMembers = new Set<string>();

  if (isDevMode()) {
    for (const overriddenMember of overrideMap.keys()) {
      if (documentMemberClassification[overriddenMember] !== 'virtualized') {
        console.warn(
          `Braid compat: document facade override '${overriddenMember}' is not classified as 'virtualized' in document-member-classification.ts! Please classify it to keep the audit trail consistent.`,
        );
      }
    }
  }

  function warnIfUnaudited(propertyName: string) {
    if (isUnauditedDocumentMember(propertyName) && !warnedMembers.has(propertyName)) {
      warnedMembers.add(propertyName);
      console.warn(
        `Braid compat: a fragment accessed 'document.${propertyName}', which has not been audited for compat fragment contexts yet and falls through to the fragment's hidden realm document.\n` +
          `If the fragment misbehaves in a way related to this API, please report it at https://github.com/Jefftopia/skew/issues`,
      );
    }
  }

  const facadeProxy = new Proxy(originalPrototype, {
    get(target, property, receiver) {
      if (typeof property === 'string') {
        const override = overrideMap.get(property);
        if (override) {
          return override.get ? override.get() : override.value;
        }
        if (isDevMode()) {
          warnIfUnaudited(property);
        }
      }
      return Reflect.get(target, property, receiver);
    },

    set(target, property, value, receiver) {
      if (typeof property === 'string') {
        const override = overrideMap.get(property);
        if (override) {
          if (override.set) {
            override.set(value);
            return true;
          }
          // read-only virtualized member: fail the assignment just like an assignment to a
          // non-writable property would (throws in strict mode, silently ignored otherwise)
          return false;
        }
        if (isDevMode()) {
          warnIfUnaudited(property);
        }
      }
      return Reflect.set(target, property, value, receiver);
    },
  });

  Object.setPrototypeOf(realmDocument, facadeProxy);

  return function uninstallDocumentFacade() {
    Object.setPrototypeOf(realmDocument, originalPrototype);
  };
}
