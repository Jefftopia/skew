import { ApplicationConfig, provideZonelessChangeDetection } from '@angular/core';
import { provideClientHydration, withIncrementalHydration } from '@angular/platform-browser';
import { provideRouter } from '@angular/router';
import { routes } from './app.routes';

/**
 * Shared by both bootstraps. Hydration has to be configured on both or it silently does nothing —
 * the server emits the annotations the client reuses, and without them Angular discards the
 * server-rendered DOM and rebuilds it.
 *
 * Inside a fragment realm that discarding is worse than a wasted render: the DOM being thrown away
 * is the markup the gateway pierced into the host's response, so the widget would visibly blank and
 * re-appear. Whether Angular's hydration traversal works through the compat document facade at all
 * is the main unknown this POC exists to answer.
 */
export const appConfig: ApplicationConfig = {
  providers: [
    provideZonelessChangeDetection(),
    provideRouter(routes),
    provideClientHydration(withIncrementalHydration()),
  ],
};
