import { TestBed } from '@angular/core/testing';
import { createSkewStoreToken, provideSkewStore } from './provide';
import { versioned, memoryDriver } from '@braid/skew';

const TestSchema = versioned<{ val: string }>('test-schema');

describe('provide', () => {
  it('creates a typed injection token', () => {
    const token = createSkewStoreToken('TEST_TOKEN');
    expect(token.toString()).toContain('TEST_TOKEN');
  });

  it('provides a VersionedStore instance to the Angular DI container', () => {
    const token = createSkewStoreToken<any>('TEST_TOKEN');
    
    TestBed.configureTestingModule({
      providers: [
        provideSkewStore(token, TestSchema, { driver: memoryDriver() })
      ]
    });

    const store = TestBed.inject(token);
    expect(store).toBeDefined();
    expect(typeof store.get).toBe('function');
    expect(typeof store.peek).toBe('function');
    expect(typeof store.set).toBe('function');
  });
});
