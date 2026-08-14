import { describe, expect, it } from 'vitest';
import type { FragmentManifest } from '@skewkit/braid-gateway';
import {
  addFragment,
  createDraft,
  draftStatus,
  formatList,
  parseList,
  removeFragment,
  resetDraft,
  updateFragment,
} from './draft.js';

const base: FragmentManifest[] = [
  { id: 'billing', endpoint: 'https://billing.internal', pierce: ['/billing/*'], title: 'Billing' },
];

describe('draft', () => {
  it('starts clean and identical to its base', () => {
    const status = draftStatus(createDraft(base, 'reg_x'));

    expect(status.clean).toBe(true);
    expect(status.blocked).toBe(false);
  });

  it('does not share structure with its base, so edits cannot mutate it', () => {
    const draft = updateFragment(createDraft(base), 0, { title: 'Changed' });

    expect(base[0]?.title).toBe('Billing');
    expect(draft.base[0]?.title).toBe('Billing');
    expect(draft.manifests[0]?.title).toBe('Changed');
  });

  it('reports a change as a diff against the base', () => {
    const status = draftStatus(updateFragment(createDraft(base), 0, { pierce: ['/billing/*', '/invoices/*'] }));

    expect(status.clean).toBe(false);
    expect(status.diff.changed[0]?.changes[0]).toMatchObject({ field: 'pierce', owner: 'gateway' });
  });

  it('blocks publishing when the draft has errors', () => {
    const status = draftStatus(updateFragment(createDraft(base), 0, { endpoint: 'not-a-url' }));

    expect(status.blocked).toBe(true);
    expect(status.findings[0]?.code).toBe('invalid-endpoint');
  });

  it('does not block on warnings alone', () => {
    const draft = createDraft([
      { id: 'a', endpoint: 'https://a.internal', pierce: ['/*'] },
      { id: 'b', endpoint: 'https://b.internal', pierce: ['/billing/*'] },
    ]);
    const status = draftStatus(draft);

    expect(status.findings[0]?.code).toBe('pierce-overlap');
    expect(status.blocked).toBe(false);
  });

  it('adds a fragment with an id that does not collide', () => {
    const once = addFragment(createDraft(base));
    const twice = addFragment(once);

    expect(twice.manifests.map((m) => m.id)).toEqual(['billing', 'new-fragment', 'new-fragment-2']);
  });

  it('removes by position, not by id, so duplicates stay editable', () => {
    const draft = createDraft([base[0]!, { ...base[0]!, endpoint: 'https://other.internal' }]);

    const after = removeFragment(draft, 0);

    expect(after.manifests).toHaveLength(1);
    expect(after.manifests[0]?.endpoint).toBe('https://other.internal');
  });

  it('discards every edit on reset', () => {
    const edited = removeFragment(updateFragment(createDraft(base, 'reg_x'), 0, { title: 'Changed' }), 0);

    const status = draftStatus(resetDraft(edited));

    expect(status.clean).toBe(true);
  });

  describe('clearing a field', () => {
    it('removes it rather than storing an empty string', () => {
      // an omitted field is what lets a fragment descriptor supply it; `title: ''` is not the same
      const draft = updateFragment(createDraft(base), 0, { title: '' });

      expect('title' in draft.manifests[0]!).toBe(false);
    });

    it('drops an emptied list', () => {
      const draft = updateFragment(createDraft(base), 0, { pierce: [] });

      expect('pierce' in draft.manifests[0]!).toBe(false);
    });

    it('drops an emptied access object', () => {
      const draft = updateFragment(createDraft([{ ...base[0]!, access: { list: { roles: ['x'] } } }]), 0, {
        access: {},
      });

      expect('access' in draft.manifests[0]!).toBe(false);
    });

    it('keeps a blank id or endpoint so validation can report them', () => {
      const draft = updateFragment(createDraft(base), 0, { id: '', endpoint: '' });

      expect(draft.manifests[0]).toMatchObject({ id: '', endpoint: '' });
      expect(draftStatus(draft).blocked).toBe(true);
    });
  });
});

describe('list fields', () => {
  it('parses a comma-separated value, trimming and dropping blanks', () => {
    expect(parseList(' /a/* , , /b/* ')).toEqual(['/a/*', '/b/*']);
  });

  it('round-trips', () => {
    expect(parseList(formatList(['finance', 'core']))).toEqual(['finance', 'core']);
  });

  it('treats an empty string as an empty list', () => {
    expect(parseList('')).toEqual([]);
  });
});
