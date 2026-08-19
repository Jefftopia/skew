import { TestBed } from '@angular/core/testing';
import { Injector, runInInjectionContext } from '@angular/core';
import { memoryRecordDriver, type RecordDriver } from '@skewkit/data';
import { beforeEach, describe, expect, it } from 'vitest';
import { DATA_OPTIONS, resolveDataOptions } from './config';
import { entity } from './entity';
import { mutation } from './mutation';
import { OutboxService } from './outbox';
import { EntityStore } from './store';

/**
 * The optimistic overlay, as the Angular store shows it.
 *
 * These are the tests the old apply-then-undo design could not have passed, and each one is a bug a
 * user would have reported as something else: an edit that vanished after a reload, a second app
 * showing a stale value, a rollback that restored the wrong thing because the undo log was written
 * before another write landed.
 */

interface Bulletin {
  id: string;
  title: string;
  status: 'draft' | 'published';
}

const Bulletin = entity<Bulletin>({ name: 'bulletin', key: (b) => b.id });
const draft = (id = '1'): Bulletin => ({ id, title: 'Sunday', status: 'draft' });

/** A fresh TestBed over the same storage is exactly what a page refresh looks like. */
function configure(options: { driver?: RecordDriver; owner?: string } = {}) {
  const driver = options.driver ?? memoryRecordDriver();

  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      {
        provide: DATA_OPTIONS,
        useValue: resolveDataOptions({ driver, owner: options.owner ?? 'bulletins' }),
      },
    ],
  });

  return {
    driver,
    store: TestBed.inject(EntityStore),
    outbox: TestBed.inject(OutboxService),
    injector: TestBed.inject(Injector),
  };
}

beforeEach(() => TestBed.resetTestingModule());

describe('the optimistic overlay in the entity store', () => {
  it('survives a reload, because it was never in memory to begin with', async () => {
    const driver = memoryRecordDriver();
    const first = configure({ driver });
    first.store.upsert(Bulletin, draft());

    const publish = runInInjectionContext(first.injector, () =>
      mutation<Bulletin, void>({
        id: 'bulletin.publish',
        durability: 'outbox',
        operation: async () => {
          throw new Error('offline');
        },
        optimistic: (tx, b) => tx.patch(Bulletin, b.id, { status: 'published' }),
      }),
    );
    await publish.mutate(draft());
    expect(first.store.select(Bulletin, '1')()?.status).toBe('published');

    // The reload. Nothing in memory survives; the queue does.
    const after = configure({ driver });
    after.store.upsert(Bulletin, draft()); // the server still reports a draft
    await after.outbox.load();

    expect(after.store.select(Bulletin, '1')()?.status).toBe('published');
    expect(after.outbox.pendingCount()).toBe(1);
  });

  it('shows one app the unsent edit another app made', async () => {
    // The queue is shared per origin, so the overlay derived from it is too. An undo log in the
    // writer's memory could never have reached the second app.
    const driver = memoryRecordDriver();
    const writer = configure({ driver, owner: 'editor' });
    writer.store.upsert(Bulletin, draft());

    const publish = runInInjectionContext(writer.injector, () =>
      mutation<Bulletin, void>({
        id: 'bulletin.publish',
        durability: 'outbox',
        operation: async () => {
          throw new Error('offline');
        },
        optimistic: (tx, b) => tx.patch(Bulletin, b.id, { status: 'published' }),
      }),
    );
    await publish.mutate(draft());

    const reader = configure({ driver, owner: 'reader' });
    reader.store.upsert(Bulletin, draft());
    await reader.outbox.load();

    expect(reader.store.select(Bulletin, '1')()?.status).toBe('published');
    // Not this app's to replay — it is waiting for its owner, and shown meanwhile.
    expect(reader.outbox.entries()).toHaveLength(0);
    expect(reader.outbox.pendingCount()).toBe(1);
  });

  it('lifts the overlay once the entry is gone, leaving the confirmed value', async () => {
    const { store, injector } = configure();
    store.upsert(Bulletin, draft());

    const publish = runInInjectionContext(injector, () =>
      mutation<Bulletin, Bulletin>({
        operation: async (b) => ({ ...b, status: 'published' }),
        optimistic: (tx, b) => tx.patch(Bulletin, b.id, { status: 'published' }),
        onSuccess: (s, result) => s.upsert(Bulletin, result),
      }),
    );

    await publish.mutate(draft());

    expect(store.select(Bulletin, '1')()?.status).toBe('published');
    expect(publish.hasPendingWrite()).toBe(false);
    // Nothing was rolled back and nothing double-applied: the confirmed record now says it.
    expect(store.peekConfirmed(Bulletin, '1')?.status).toBe('published');
  });

  it('shows a pending creation in list reads, and hides a pending removal', async () => {
    const { store, injector } = configure();
    store.upsert(Bulletin, draft('1'));

    const create = runInInjectionContext(injector, () =>
      mutation<Bulletin, void>({
        operation: () => new Promise<void>(() => undefined), // never settles
        optimistic: (tx, b) => tx.upsert(Bulletin, b),
      }),
    );
    const remove = runInInjectionContext(injector, () =>
      mutation<string, void>({
        operation: () => new Promise<void>(() => undefined),
        optimistic: (tx, id) => tx.remove(Bulletin, id),
      }),
    );

    void create.mutate(draft('2'));
    void remove.mutate('1');

    const titles = store.selectAll(Bulletin)().map((b) => b.id);
    expect(titles).toEqual(['2']);
    expect(store.select(Bulletin, '1')()).toBeUndefined();
  });
});

describe('conflict reporting', () => {
  const setup = () => {
    const context = configure();
    context.store.upsert(Bulletin, draft());
    return context;
  };

  /** The server accepts the write and stores a normalized title. */
  const rewriting = (input: Bulletin): Promise<Bulletin> =>
    Promise.resolve({ ...input, status: 'published', title: input.title.toUpperCase() });

  const config = {
    operation: rewriting,
    optimistic: (tx: Parameters<NonNullable<Parameters<typeof mutation>[0]['optimistic']>>[0], b: Bulletin) =>
      tx.patch(Bulletin, b.id, { status: 'published', title: b.title }),
    onSuccess: (s: EntityStore, result: Bulletin) => s.upsert(Bulletin, result),
  };

  it('raises by default, naming the field the server disagreed about', async () => {
    const { store, injector } = setup();
    const publish = runInInjectionContext(injector, () => mutation<Bulletin, Bulletin>(config));

    await publish.mutate({ ...draft(), title: 'Sunday' });

    const raised = publish.conflict();
    expect(raised?.paths).toEqual(['title']);
    expect((raised?.expected as Bulletin).title).toBe('Sunday');
    expect((raised?.actual as Bulletin).title).toBe('SUNDAY');
    expect(raised?.entity).toEqual({ typeName: 'bulletin', id: '1' });

    // The server's value is what is stored: there is no client-wins option to offer.
    expect(store.select(Bulletin, '1')()?.title).toBe('SUNDAY');

    publish.acknowledgeConflict();
    expect(publish.conflict()).toBeNull();
  });

  it('stays silent under "accept"', async () => {
    const { store, injector } = setup();
    const publish = runInInjectionContext(injector, () =>
      mutation<Bulletin, Bulletin>({ ...config, onConflict: 'accept' }),
    );

    await publish.mutate({ ...draft(), title: 'Sunday' });

    expect(publish.conflict()).toBeNull();
    expect(store.select(Bulletin, '1')()?.title).toBe('SUNDAY');
  });

  it('stores what a resolver returns', async () => {
    const { store, injector } = setup();
    const publish = runInInjectionContext(injector, () =>
      mutation<Bulletin, Bulletin>({
        ...config,
        onConflict: (found) => ({ ...(found.actual as Bulletin), title: (found.expected as Bulletin).title }),
      }),
    );

    await publish.mutate({ ...draft(), title: 'Sunday' });

    expect(publish.conflict()).toBeNull();
    expect(store.select(Bulletin, '1')()?.title).toBe('Sunday');
    expect(store.select(Bulletin, '1')()?.status).toBe('published');
  });

  it('reports nothing when the response is not the record', async () => {
    // A `void` or receipt response has not contradicted anything, and inventing a conflict out of a
    // shape mismatch would train users to dismiss the real ones.
    const { injector } = setup();
    const publish = runInInjectionContext(injector, () =>
      mutation<Bulletin, void>({
        operation: async () => undefined,
        optimistic: (tx, b) => tx.patch(Bulletin, b.id, { status: 'published' }),
      }),
    );

    await publish.mutate(draft());

    expect(publish.conflict()).toBeNull();
  });
});
