import {
  type EnvironmentProviders,
  makeEnvironmentProviders,
  provideEnvironmentInitializer,
} from '@angular/core';
import { setSkewDisabled } from '@skewkit/core';

/**
 * ⚠️ NOT PUBLIC API. Undocumented on purpose. Do not use in an application.
 *
 * Angular-shaped wrapper around `setSkewDisabled()` from `@skewkit/core`. Read the
 * module comment in `@skewkit/core`'s `disabled.ts` first — it explains what this
 * turns off, why it exists, and why it is deliberately absent from the README,
 * the package docs, and every example.
 *
 * ```ts
 * // demo apps only
 * providers: [provideSkewRecovery({ … }), provideSkewDisabled()]
 * ```
 *
 * Two things worth knowing before using it anyway:
 *
 * **It is not scoped to this injector.** The flag lives in a module-level
 * variable in `@skewkit/core`, because core is framework-agnostic and has no
 * injector to read from. Calling this affects every `@skewkit` package sharing
 * that instance of core — including any other Angular application on the page.
 * It is `provide*`-shaped for familiarity, not because it is scoped.
 *
 * **It applies at bootstrap.** For a control that flips at runtime — which is
 * what a before/after demo actually wants — call `setSkewDisabled()` directly.
 * Every check reads the flag at the moment it runs, so a later toggle takes
 * effect on the next read, navigation or write with no reload.
 *
 * This lives in `@skewkit/angular-router` for want of a shared Angular package;
 * it belongs in `@skewkit/angular-core` once that lands, since it governs all of
 * them and nothing here is router-specific.
 *
 * @internal
 */
export function provideSkewDisabled(disabled = true): EnvironmentProviders {
  return makeEnvironmentProviders([
    provideEnvironmentInitializer(() => setSkewDisabled(disabled)),
  ]);
}
