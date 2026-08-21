import { DestroyRef, EnvironmentProviders, inject, makeEnvironmentProviders, PLATFORM_ID, provideEnvironmentInitializer } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NavigationEnd, NavigationSkipped, Router } from '@angular/router';
import { filter } from 'rxjs';
import { initBraid, type BraidOptions } from '@braid/core';

/**
 * Initializes Braid for an Angular host, and tells it when the router navigates.
 *
 * ```ts
 * bootstrapApplication(App, { providers: [provideRouter(routes), provideBraid()] });
 * ```
 *
 * The router wiring is the part worth having a binding for. Braid never patches the host's
 * History API — host purity is an invariant — so bound fragments learn about host navigation
 * through a callback. It has to be an *after*-navigation signal: `NavigationStart` fires before
 * the URL changes, so notifying then reports a location the page has not reached, and fragments
 * end up a navigation behind. This wires `NavigationEnd` and `NavigationSkipped` (the latter
 * covers same-URL navigations), unsubscribing with the injector.
 *
 * Safe to include in a bootstrap shared with the server: on the server it does nothing, because
 * `<fragment-slot>` is a browser custom element and the fragment's markup is composed into the
 * SSR output by the gateway rather than by Angular.
 */
export function provideBraid(options: BraidOptions = {}): EnvironmentProviders {
  return makeEnvironmentProviders([
    provideEnvironmentInitializer(() => {
      if (!isPlatformBrowser(inject(PLATFORM_ID))) return;

      // captured here, in injection context; the callback below runs later, when the first
      // bound fragment boots and asks Braid for host navigation sources
      const router = inject(Router, { optional: true });
      const destroyRef = inject(DestroyRef);

      initBraid({
        ...options,
        onHostNavigation: (notify) => {
          options.onHostNavigation?.(notify);

          router?.events
            .pipe(
              filter((event) => event instanceof NavigationEnd || event instanceof NavigationSkipped),
              takeUntilDestroyed(destroyRef),
            )
            .subscribe(() => notify());
        },
      });
    }),
  ]);
}
