import { ApplicationConfig, provideZonelessChangeDetection } from '@angular/core';
import { provideClientHydration, withIncrementalHydration } from '@angular/platform-browser';
import { provideRouter } from '@angular/router';
import { routes } from './app.routes';

/**
 * Providers shared by the browser and server bootstraps.
 *
 * Hydration must be configured on **both** sides or it silently does nothing: the server has to
 * emit the hydration annotations for the client to reuse. That matters more than usual here —
 * without hydration Angular discards the server-rendered DOM and re-creates it, which destroys
 * the `<fragment-slot>` the gateway already filled and boots a second realm to fetch it again.
 *
 * `withIncrementalHydration()` additionally lets `@defer (hydrate on …)` blocks stay
 * server-rendered but dehydrated until their trigger fires — exercised on the billing page,
 * which also hosts a fragment, so the two mechanisms are proven to coexist.
 */
export const appConfig: ApplicationConfig = {
  providers: [
    provideZonelessChangeDetection(),
    provideRouter(routes),
    provideClientHydration(withIncrementalHydration()),
  ],
};
