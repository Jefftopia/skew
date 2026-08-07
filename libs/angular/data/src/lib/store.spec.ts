import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { entity, tag } from './entity';
import { EntityStore } from './store';

interface Bulletin {
  id: string;
  title: string;
  status: 'draft' | 'published';
}

const Bulletin = entity<Bulletin>({ name: 'bulletin', key: (b) => b.id });
const draft = (id: string, title = 'Untitled'): Bulletin => ({ id, title, status: 'draft' });

let store: EntityStore;
beforeEach(() => {
  TestBed.resetTestingModule();
  store = TestBed.inject(EntityStore);
});

describe('EntityStore', () => {
  it('upserts and selects a record', () => {
    store.upsert(Bulletin, draft('1', 'Advent'));
    expect(store.select(Bulletin, '1')()).toEqual(draft('1', 'Advent'));
  });

  it('returns undefined for an absent record', () => {
    expect(store.select(Bulletin, 'nope')()).toBeUndefined();
  });

  it('reuses the same signal for the same record', () => {
    // Creating a fresh computed per call would mint one per change-detection
    // pass if select() were used in a template.
    expect(store.select(Bulletin, '1')).toBe(store.select(Bulletin, '1'));
    expect(store.selectAll(Bulletin)).toBe(store.selectAll(Bulletin));
  });

  it('propagates an update to every view of the same entity', () => {
    store.upsert(Bulletin, [draft('1'), draft('2')]);
    const one = store.select(Bulletin, '1');
    const all = store.selectAll(Bulletin);

    store.patch(Bulletin, '1', { status: 'published' });

    expect(one()?.status).toBe('published');
    expect(all().find((b) => b.id === '1')?.status).toBe('published');
  });

  it('upserts an array in one notification', () => {
    store.upsert(Bulletin, [draft('1'), draft('2'), draft('3')]);
    expect(store.selectAll(Bulletin)()).toHaveLength(3);
  });

  it('ignores a patch to a record that does not exist', () => {
    store.patch(Bulletin, 'ghost', { title: 'x' });
    expect(store.select(Bulletin, 'ghost')()).toBeUndefined();
  });

  it('removes a record', () => {
    store.upsert(Bulletin, draft('1'));
    store.remove(Bulletin, '1');
    expect(store.select(Bulletin, '1')()).toBeUndefined();
    expect(store.selectAll(Bulletin)()).toHaveLength(0);
  });

  it('filters with query()', () => {
    store.upsert(Bulletin, [draft('1'), { ...draft('2'), status: 'published' as const }]);
    const published = store.query(Bulletin, (b) => b.status === 'published');
    expect(published().map((b) => b.id)).toEqual(['2']);
  });

  it('peeks without creating a subscription', () => {
    store.upsert(Bulletin, draft('1', 'Peeked'));
    expect(store.peek(Bulletin, '1')?.title).toBe('Peeked');
  });

  it('clears a single type and the whole store', () => {
    store.upsert(Bulletin, draft('1'));
    store.clear(Bulletin);
    expect(store.selectAll(Bulletin)()).toHaveLength(0);

    store.upsert(Bulletin, draft('2'));
    store.clear();
    expect(store.selectAll(Bulletin)()).toHaveLength(0);
  });
});

describe('transactions', () => {
  it('rolls a patch back to the exact prior value', () => {
    store.upsert(Bulletin, draft('1', 'Original'));
    const tx = store.transaction();

    tx.apply((t) => t.patch(Bulletin, '1', { status: 'published', title: 'Changed' }));
    expect(store.select(Bulletin, '1')?.()?.status).toBe('published');

    tx.rollback();

    expect(store.select(Bulletin, '1')()).toEqual(draft('1', 'Original'));
    expect(tx.committed).toBe(false);
  });

  it('removes a record that did not exist before the transaction', () => {
    const tx = store.transaction();
    tx.apply((t) => t.upsert(Bulletin, draft('new')));
    expect(store.select(Bulletin, 'new')()).toBeDefined();

    tx.rollback();

    expect(store.select(Bulletin, 'new')()).toBeUndefined();
  });

  it('restores a removed record', () => {
    store.upsert(Bulletin, draft('1', 'Keep me'));
    const tx = store.transaction();

    tx.apply((t) => t.remove(Bulletin, '1'));
    tx.rollback();

    expect(store.select(Bulletin, '1')()?.title).toBe('Keep me');
  });

  it('restores the value from before the transaction, not an intermediate one', () => {
    store.upsert(Bulletin, draft('1', 'Original'));
    const tx = store.transaction();

    tx.apply((t) => t.patch(Bulletin, '1', { title: 'First' }));
    tx.apply((t) => t.patch(Bulletin, '1', { title: 'Second' }));
    tx.rollback();

    expect(store.select(Bulletin, '1')()?.title).toBe('Original');
  });

  it('is idempotent — a second rollback does nothing', () => {
    store.upsert(Bulletin, draft('1', 'Original'));
    const tx = store.transaction();
    tx.apply((t) => t.patch(Bulletin, '1', { title: 'Changed' }));

    tx.rollback();
    store.patch(Bulletin, '1', { title: 'Later edit' });
    tx.rollback();

    // The second rollback must not resurrect stale state over a newer write.
    expect(store.select(Bulletin, '1')()?.title).toBe('Later edit');
  });

  it('rolls back writes across several entity types', () => {
    const Draft = entity<{ id: string; n: number }>({ name: 'draftItem', key: (d) => d.id });
    store.upsert(Bulletin, draft('1'));
    store.upsert(Draft, { id: 'a', n: 1 });

    const tx = store.transaction();
    tx.apply((t) => {
      t.patch(Bulletin, '1', { title: 'changed' });
      t.patch(Draft, 'a', { n: 99 });
    });
    tx.rollback();

    expect(store.select(Bulletin, '1')()?.title).toBe('Untitled');
    expect(store.select(Draft, 'a')()?.n).toBe(1);
  });
});

describe('tag helpers', () => {
  it('builds entity, wildcard and collection tags', () => {
    expect(tag.entity(Bulletin, '42')).toBe('bulletin#42');
    expect(tag.all(Bulletin)).toBe('bulletin#*');
    expect(tag.collection('bulletins')).toBe('bulletins');
  });
});

describe('entity()', () => {
  it('rejects a definition without a name or key', () => {
    expect(() => entity({ name: '', key: (x: { id: string }) => x.id })).toThrow(TypeError);
    expect(() => entity({ name: 'x', key: undefined as never })).toThrow(TypeError);
  });
});
