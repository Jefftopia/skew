import { Injector, runInInjectionContext } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CacheRegistry, tagsMatch } from './cache-registry';
import { DATA_OPTIONS, resolveDataOptions } from './config';
import { entity, tag } from './entity';
import { mutation } from './mutation';
import { query } from './query';
import { EntityStore } from './store';

interface Bulletin {
  id: string;
  title: string;
  status: 'draft' | 'published';
}
const Bulletin = entity<Bulletin>({ name: 'bulletin', key: (b) => b.id });
const rec = (id: string, title = 'T'): Bulletin => ({ id, title, status: 'draft' });

/** Lets the microtask queue drain so an async loader settles. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

let injector: Injector;
let store: EntityStore;
let registry: CacheRegistry;

beforeEach(() => {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [{ provide: DATA_OPTIONS, useValue: resolveDataOptions({}) }],
  });
  injector = TestBed.inject(Injector);
  store = TestBed.inject(EntityStore);
  registry = TestBed.inject(CacheRegistry);
});

describe('query()', () => {
  it('loads and exposes status transitions', async () => {
    const ref = runInInjectionContext(injector, () =>
      query({ loader: async () => [rec('1')] }),
    );
    expect(ref.status()).toBe('loading');

    await settle();

    expect(ref.status()).toBe('success');
    expect(ref.isLoading()).toBe(false);
    expect(ref.value()).toHaveLength(1);
  });

  it('normalizes an array response into the store', async () => {
    runInInjectionContext(injector, () =>
      query({ loader: async () => [rec('1'), rec('2')], normalize: Bulletin }),
    );
    await settle();

    expect(store.selectAll(Bulletin)()).toHaveLength(2);
    expect(store.select(Bulletin, '1')()?.title).toBe('T');
  });

  it('normalizes a single record and an enveloped list', async () => {
    runInInjectionContext(injector, () =>
      query({ loader: async () => rec('solo'), normalize: Bulletin }),
    );
    runInInjectionContext(injector, () =>
      query({ loader: async () => ({ items: [rec('a'), rec('b')] }), normalize: Bulletin }),
    );
    await settle();

    expect(store.select(Bulletin, 'solo')()).toBeDefined();
    expect(store.select(Bulletin, 'a')()).toBeDefined();
    expect(store.select(Bulletin, 'b')()).toBeDefined();
  });

  it('captures loader failures without throwing', async () => {
    const ref = runInInjectionContext(injector, () =>
      query({
        loader: async () => {
          throw new Error('boom');
        },
      }),
    );
    await settle();

    expect(ref.status()).toBe('error');
    expect((ref.error() as Error).message).toBe('boom');
  });

  it('re-runs when a subscribed tag is invalidated', async () => {
    const loader = vi.fn(async () => [rec('1')]);
    runInInjectionContext(injector, () =>
      query({ loader, normalize: Bulletin, tags: () => ['bulletins'] }),
    );
    await settle();
    expect(loader).toHaveBeenCalledOnce();

    registry.invalidate('bulletins');
    await settle();

    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('ignores invalidation of an unrelated tag', async () => {
    const loader = vi.fn(async () => [rec('1')]);
    runInInjectionContext(injector, () => query({ loader, tags: () => ['bulletins'] }));
    await settle();

    registry.invalidate('parishes');
    await settle();

    expect(loader).toHaveBeenCalledOnce();
  });

  it('discards an out-of-order response', async () => {
    // A slow first request must not overwrite the newer one that beat it home.
    let resolveSlow: ((value: Bulletin[]) => void) | undefined;
    const loader = vi
      .fn()
      .mockImplementationOnce(() => new Promise<Bulletin[]>((r) => (resolveSlow = r)))
      .mockImplementationOnce(async () => [rec('fresh')]);

    const ref = runInInjectionContext(injector, () => query<Bulletin[]>({ loader }));
    await ref.reload();
    resolveSlow?.([rec('stale')]);
    await settle();

    expect(ref.value()?.[0]?.id).toBe('fresh');
  });

  it('can defer the initial load', async () => {
    const loader = vi.fn(async () => [rec('1')]);
    const ref = runInInjectionContext(injector, () => query({ loader, immediate: false }));
    await settle();

    expect(loader).not.toHaveBeenCalled();
    expect(ref.status()).toBe('idle');

    await ref.reload();
    expect(loader).toHaveBeenCalledOnce();
  });
});

describe('mutation()', () => {
  it('applies an optimistic change immediately, before the server answers', async () => {
    store.upsert(Bulletin, rec('1'));
    let release: (() => void) | undefined;
    const publish = runInInjectionContext(injector, () =>
      mutation<Bulletin, void>({
        operation: () => new Promise<void>((r) => (release = r)),
        optimistic: (tx, b) => tx.patch(Bulletin, b.id, { status: 'published' }),
      }),
    );

    const inFlight = publish.mutate(store.peek(Bulletin, '1') as Bulletin);

    expect(store.select(Bulletin, '1')()?.status).toBe('published');
    expect(publish.isPending()).toBe(true);

    release?.();
    await inFlight;
    expect(publish.status()).toBe('success');
  });

  it('rolls the optimistic change back when the operation fails', async () => {
    store.upsert(Bulletin, rec('1'));
    const publish = runInInjectionContext(injector, () =>
      mutation<Bulletin, void>({
        operation: async () => {
          throw new Error('rejected');
        },
        optimistic: (tx, b) => tx.patch(Bulletin, b.id, { status: 'published' }),
      }),
    );

    await expect(publish.mutate(rec('1'))).rejects.toThrow('rejected');

    expect(store.select(Bulletin, '1')()?.status).toBe('draft');
    expect(publish.status()).toBe('error');
  });

  it('invalidates tags after a successful write', async () => {
    const loader = vi.fn(async () => [rec('1')]);
    runInInjectionContext(injector, () => query({ loader, tags: () => ['bulletins'] }));
    await settle();

    const publish = runInInjectionContext(injector, () =>
      mutation<Bulletin, void>({
        operation: async () => undefined,
        invalidates: () => ['bulletins'],
      }),
    );
    await publish.mutate(rec('1'));
    await settle();

    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('writes the server response back through onSuccess', async () => {
    const publish = runInInjectionContext(injector, () =>
      mutation<string, Bulletin>({
        operation: async (id) => ({ id, title: 'From server', status: 'published' }),
        onSuccess: (s, result) => s.upsert(Bulletin, result),
      }),
    );

    await publish.mutate('9');

    expect(store.select(Bulletin, '9')()?.title).toBe('From server');
  });

  it('demands an id when durability is outbox', () => {
    expect(() =>
      runInInjectionContext(injector, () =>
        mutation({ operation: async () => undefined, durability: 'outbox' }),
      ),
    ).toThrow(/requires a stable `id`/);
  });

  it('queues instead of failing when an outbox mutation cannot reach the server', async () => {
    store.upsert(Bulletin, rec('1'));
    const publish = runInInjectionContext(injector, () =>
      mutation<Bulletin, void>({
        id: 'bulletin.publish',
        operation: async () => {
          throw new Error('offline');
        },
        optimistic: (tx, b) => tx.patch(Bulletin, b.id, { status: 'published' }),
        durability: 'outbox',
        schemaVersion: 41,
      }),
    );

    await publish.mutate(rec('1'));

    // The optimistic state survives: from the user's view it saved, and it
    // will reach the server when connectivity returns.
    expect(store.select(Bulletin, '1')()?.status).toBe('published');
    expect(publish.status()).toBe('success');
  });
});

describe('tagsMatch', () => {
  it('matches exact tags', () => {
    expect(tagsMatch('bulletins', 'bulletins')).toBe(true);
    expect(tagsMatch('bulletins', 'parishes')).toBe(false);
  });

  it('matches a wildcard in either position', () => {
    expect(tagsMatch(tag.all(Bulletin), 'bulletin#42')).toBe(true);
    expect(tagsMatch('bulletin#42', tag.all(Bulletin))).toBe(true);
  });

  it('does not match across types', () => {
    expect(tagsMatch('parish#*', 'bulletin#42')).toBe(false);
  });
});

describe('CacheRegistry', () => {
  it('isolates a throwing subscriber from the rest', () => {
    const good = vi.fn();
    registry.subscribe(
      () => ['x'],
      () => {
        throw new Error('bad subscriber');
      },
    );
    registry.subscribe(() => ['x'], good);

    expect(() => registry.invalidate('x')).not.toThrow();
    expect(good).toHaveBeenCalledOnce();
  });

  it('stops notifying after dispose', () => {
    const notify = vi.fn();
    const dispose = registry.subscribe(() => ['x'], notify);

    dispose();
    registry.invalidate('x');

    expect(notify).not.toHaveBeenCalled();
  });

  it('re-reads tags on each invalidation', () => {
    let tags = ['a'];
    const notify = vi.fn();
    registry.subscribe(() => tags, notify);

    registry.invalidate('b');
    expect(notify).not.toHaveBeenCalled();

    tags = ['b'];
    registry.invalidate('b');
    expect(notify).toHaveBeenCalledOnce();
  });
});
