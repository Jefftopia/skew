import { describe, expect, it } from 'vitest';
import { findPiercedContentRoot, FragmentSlot } from './fragment-slot.js';

/** Builds the shadow root shape the gateway pierces into a slot. */
function piercedSlot(): ShadowRoot {
  const slot = document.createElement('fragment-slot');
  const shadowRoot = slot.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  const contentRoot = document.createElement('braid-document');
  contentRoot.append(document.createElement('braid-html'));
  shadowRoot.append(style, contentRoot);
  return shadowRoot;
}

describe('findPiercedContentRoot()', () => {
  it('finds the content root the gateway pierced in', () => {
    const shadowRoot = piercedSlot();
    expect(findPiercedContentRoot(shadowRoot)?.tagName).toBe('BRAID-DOCUMENT');
  });

  it('is not fooled by the :scope selector pitfall on a ShadowRoot', () => {
    // regression guard: `:scope > braid-document` matches nothing on a ShadowRoot, which made
    // every pierced fragment silently re-fetch. Assert the platform behavior that caused it, so
    // anyone tempted to "simplify" the helper back into a selector sees why they shouldn't.
    const shadowRoot = piercedSlot();
    expect(shadowRoot.querySelector(':scope > braid-document')).toBeNull();
    expect(findPiercedContentRoot(shadowRoot)).not.toBeNull();
  });

  it('returns null for a slot with no pierced content', () => {
    const slot = document.createElement('fragment-slot');
    const shadowRoot = slot.attachShadow({ mode: 'open' });
    shadowRoot.append(document.createElement('style'));

    expect(findPiercedContentRoot(shadowRoot)).toBeNull();
    expect(findPiercedContentRoot(null)).toBeNull();
  });

  it('ignores a braid-document that is not a direct child', () => {
    const slot = document.createElement('fragment-slot');
    const shadowRoot = slot.attachShadow({ mode: 'open' });
    const wrapper = document.createElement('div');
    wrapper.append(document.createElement('braid-document'));
    shadowRoot.append(wrapper);

    expect(findPiercedContentRoot(shadowRoot)).toBeNull();
  });
});

describe('FragmentSlot element', () => {
  it('observes name, src, and props attributes', () => {
    expect(FragmentSlot.observedAttributes).toEqual(['name', 'src', 'props']);
  });
});
