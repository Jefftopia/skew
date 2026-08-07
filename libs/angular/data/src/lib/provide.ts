import {
  DOCUMENT,
  type EnvironmentProviders,
  PLATFORM_ID,
  inject,
  makeEnvironmentProviders,
  provideEnvironmentInitializer,
} from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { DATA_OPTIONS, type DataOptionsInput, resolveDataOptions } from './config';
import { OutboxService } from './outbox';

/**
 * Enables the data layer.
 *
 * ```ts
 * provideSkewData({
 *   persistOutbox: true,
 *   buildId: BUILD_ID,
 *   onOutboxError: (message, detail) => telemetry.error(message, detail),
 * });
 * ```
 */
export function provideSkewData(input: DataOptionsInput = {}): EnvironmentProviders {
  const options = resolveDataOptions(input);

  return makeEnvironmentProviders([
    { provide: DATA_OPTIONS, useValue: options },
    provideEnvironmentInitializer(() => {
      const outbox = inject(OutboxService);
      const isBrowser = isPlatformBrowser(inject(PLATFORM_ID));
      if (!isBrowser) return;

      // Rehydrate immediately: work queued before the last reload should reach
      // the server as soon as this build is running, not on the next mutation.
      void outbox.load().then(() => outbox.flush());

      if (options.flushOnReconnect) {
        const view = inject(DOCUMENT).defaultView;
        view?.addEventListener('online', () => void outbox.flush());
      }
    }),
  ]);
}
