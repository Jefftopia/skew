import { InjectionToken, type EnvironmentProviders, makeEnvironmentProviders, inject } from '@angular/core';
import { type VersionedStore, type VersionedSchema, type VersionedStoreOptions, createVersionedStore } from '@skewkit/core';

/**
 * Creates an InjectionToken for a specific VersionedStore.
 * 
 * @param name A descriptive name for debugging.
 */
export function createSkewStoreToken<T>(name: string): InjectionToken<VersionedStore<T>> {
  return new InjectionToken<VersionedStore<T>>(name);
}

/**
 * Provides a VersionedStore for dependency injection.
 *
 * ```ts
 * export const USER_STORE = createSkewStoreToken<UserProfile>('USER_STORE');
 * 
 * provideSkewStore(USER_STORE, UserProfileSchema, { driver: webStorageDriver('local') })
 * ```
 */
export function provideSkewStore<T>(
  token: InjectionToken<VersionedStore<T>>,
  schema: VersionedSchema<T>,
  options: VersionedStoreOptions
): EnvironmentProviders {
  return makeEnvironmentProviders([
    {
      provide: token,
      useFactory: () => createVersionedStore(schema, options)
    }
  ]);
}
