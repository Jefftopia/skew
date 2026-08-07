import {
  type EnvironmentProviders,
  provideEnvironmentInitializer,
  makeEnvironmentProviders,
  inject,
} from '@angular/core';
import { SKEW_RECOVERY_OPTIONS, type SkewRecoveryOptions, resolveOptions } from './config';
import { SkewRecoveryService } from './recovery.service';
import { lazyDefaults } from './lazy';

/**
 * Enables skew recovery.
 *
 * ```ts
 * bootstrapApplication(App, {
 *   providers: [
 *     provideRouter(routes),
 *     provideSkewRecovery({
 *       identity: BUILD_IDENTITY,          // from @skew/build
 *       manifestUrl: '/skew-manifest.json',
 *     }),
 *   ],
 * });
 * ```
 *
 * Deliberately *not* a `RouterFeature`: Angular's feature factory is internal,
 * so third parties cannot construct one. This composes alongside
 * `provideRouter` instead, and works with any router configuration.
 *
 * The service is instantiated eagerly — it subscribes to router events, and a
 * lazily-created recovery service would miss the very first failure.
 */
export function provideSkewRecovery(options: SkewRecoveryOptions): EnvironmentProviders {
  const resolved = resolveOptions(options);

  return makeEnvironmentProviders([
    { provide: SKEW_RECOVERY_OPTIONS, useValue: resolved },
    provideEnvironmentInitializer(() => {
      // Route definitions are evaluated before DI exists, so `lazy()` cannot
      // inject its retry policy. Publishing the resolved values here keeps a
      // single source of configuration without making `lazy()` DI-aware.
      lazyDefaults.retryAttempts = resolved.retryAttempts;
      lazyDefaults.retryDelayMs = resolved.retryDelayMs;

      inject(SkewRecoveryService);
    }),
  ]);
}
