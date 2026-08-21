import { TestBed } from '@angular/core/testing';
import { createSkewStoreToken, provideSkewStore } from './provide';
import { injectSkewStore, injectSkewSignal } from './inject';
import { versioned, memoryDriver } from '@braid/skew';

const TestSchema = versioned<{ val: string }>('test-schema');

describe('inject', () => {
  const token = createSkewStoreToken<{ val: string }>('TEST');

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideSkewStore(token, TestSchema, { driver: memoryDriver() })
      ]
    });
  });

  it('injectSkewStore returns the raw store', () => {
    TestBed.runInInjectionContext(() => {
      const store = injectSkewStore(token);
      expect(store).toBeDefined();
      expect(typeof store.set).toBe('function');
    });
  });

  it('injectSkewSignal resolves synchronously on cache hit with a sync driver', async () => {
    const store = TestBed.inject(token);
    await store.set('key1', { val: 'hello' });

    TestBed.runInInjectionContext(() => {
      const sig = injectSkewSignal(token, 'key1');
      expect(sig.loading()).toBe(false);
      expect(sig.error()).toBeNull();
      expect(sig.data()).toEqual({ val: 'hello' });
    });
  });

  it('injectSkewSignal handles cache misses', () => {
    TestBed.runInInjectionContext(() => {
      const sig = injectSkewSignal(token, 'key-missing');
      expect(sig.loading()).toBe(false); // memory driver is sync, peek resolves immediately
      expect(sig.error()?.ok).toBe(false); // returns invalid/missing error
      expect(sig.data()).toBeNull();
    });
  });

  it('injectSkewSignal sets values optimistically', async () => {
    let sig: ReturnType<typeof injectSkewSignal>;
    
    TestBed.runInInjectionContext(() => {
      sig = injectSkewSignal(token, 'key2');
    });

    await sig!.set({ val: 'world' });
    expect(sig!.data()).toEqual({ val: 'world' });
    
    // Verify it actually wrote to the store
    const store = TestBed.inject(token);
    const peeked = store.peek('key2');
    expect(peeked?.ok).toBe(true);
    if (peeked?.ok) {
      expect(peeked.value).toEqual({ val: 'world' });
    }
  });
});
