import { describe, expect, it } from 'vitest';
import { documentSurface } from './document-surface.generated.js';
import { documentMemberClassification } from './document-member-classification.js';
import { createDocumentOverrides, DocumentOverridesContext } from './document-overrides.js';

function createStubContext(): DocumentOverridesContext {
  return {
    realmDocument: {} as Document,
    mainDocument: {} as Document,
    braidDocumentElement: {} as HTMLElement,
    fragmentShadowRoot: {} as ShadowRoot,
    boundNavigation: false,
    getRealmDocumentReadyState: () => 'complete',
    getCurrentScript: () => undefined,
  };
}

describe('document member classification', () => {
  it('should only classify members that exist in the spec-defined Document surface', () => {
    const unknownMembers = Object.keys(documentMemberClassification).filter((member) => !(member in documentSurface));

    expect(
      unknownMembers,
      `all classified members must be spec-defined Document members (did a member get renamed or removed ` +
        `from the browser specs? regenerate the document surface manifest)`,
    ).toEqual([]);
  });

  it('should classify exactly the members implemented by the document overrides as virtualized', () => {
    const classifiedVirtualized = Object.keys(documentMemberClassification)
      .filter((member) => documentMemberClassification[member] === 'virtualized')
      .sort();

    const implementedOverrides = Object.keys(createDocumentOverrides(createStubContext())).sort();

    expect(implementedOverrides).toEqual(classifiedVirtualized);
  });
});
