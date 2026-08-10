import {
  ApplicationConfig,
  provideBrowserGlobalErrorListeners,
} from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { provideSkewData } from '@skew/angular-data';
import { BUILD_IDENTITY } from '../generated/build-id';

/**
 * Providers for the remote *running on its own*.
 *
 * Deliberately almost empty. When the host loads `./Editor` or `./FundDetail`,
 * none of this applies — the component resolves against the *host's*
 * injector, with the host's providers and the host's build id. Anything the
 * exposed component needs from DI is something the host has to have
 * configured, sight unseen — which is why `FundDetail` asks for nothing beyond
 * `HttpClient`, the router, and `OutboxService` from `@skew/angular-data`.
 *
 * That last one deserves a note. `FundDetail`'s order submission goes through
 * the outbox (see `order-outbox.ts`), and `OutboxService` requires
 * `provideSkewData()` to have run somewhere in the injector tree. Federated
 * into the host, it already has: the host's `app.config.ts` provides it for
 * the Basics tab's wizard drafts, and `@skew/angular-data` is a shared
 * singleton across the federation boundary (see `sharedMappings` in
 * `federation.config.mjs`), so `FundDetail` reuses that same outbox instance
 * rather than needing anything added on its behalf. Standalone, there is no
 * host to inherit it from, so it is provided here too — with this build's own
 * identity, for the same reason `HttpClient` is.
 *
 * `Editor` depends on no DI at all: it reads and writes persisted envelopes,
 * which are the same on both sides of the boundary by construction. That is
 * the contract between two independently deployed builds — not a service, not
 * an interface, the bytes in storage. `FundDetail` calls the portfolio API
 * directly instead, so it needs `HttpClient` provided here for the standalone
 * case.
 */
export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideHttpClient(),
    provideSkewData({
      persistOutbox: true,
      buildId: BUILD_IDENTITY.buildId,
      onOutboxError: (message, detail) =>
        console.warn('[outbox]', message, detail),
    }),
  ],
};
