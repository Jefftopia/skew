import {
  ApplicationConfig,
  provideBrowserGlobalErrorListeners,
} from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { provideRouter } from '@angular/router';
import { provideSkewRecovery, provideSkewDisabled } from '@skew/angular-router';
import { provideSkewData } from '@skew/angular-data';
import { provideSkewWorkflow } from '@skew/angular-workflow';
import { appRoutes } from './app.routes';
import { BUILD_IDENTITY } from '../generated/build-id';
import { manifestUrl } from './origin';
import { protectionsDisabledAtBoot } from './lab';

export { BUILD_IDENTITY };

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(appRoutes),
    provideHttpClient(),

    /**
     * ⚠️ Demo only, and not something to copy.
     *
     * `provideSkewDisabled` is exported but undocumented — it makes every
     * `@skew` package inert so the demo can run each scenario with the
     * protections removed and show you the failure instead of describing it.
     * No application should ship this. It is here because a before/after that
     * only ever runs the "after" is not a comparison.
     */
    provideSkewDisabled(protectionsDisabledAtBoot()),

    provideSkewRecovery({
      /**
       * Written by `skew-stamp` during the build, so `builtAt` orders this
       * bundle against whatever the origin is currently serving. That ordering
       * is the difference between "reloading fixes this" and "reloading loops
       * forever".
       */
      identity: BUILD_IDENTITY,
      manifestUrl: manifestUrl(),

      // One retry first: a cold CDN edge and a purged asset are
      // indistinguishable from the error alone, and only one of them deserves
      // a page reload.
      retryAttempts: 1,
      retryDelayMs: 150,
    }),

    provideSkewData({
      persistOutbox: true,
      buildId: BUILD_IDENTITY.buildId,
      onOutboxError: (message, detail) =>
        console.warn('[outbox]', message, detail),
    }),

    provideSkewWorkflow({
      buildId: BUILD_IDENTITY.buildId,
      onDraftError: (message, detail) =>
        console.warn('[draft]', message, detail),
    }),
  ],
};
