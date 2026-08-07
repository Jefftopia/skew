import {
  ApplicationConfig,
  provideBrowserGlobalErrorListeners,
} from '@angular/core';

/**
 * Providers for the remote *running on its own*.
 *
 * Deliberately almost empty. When the host loads `./Editor`, none of this
 * applies — the component resolves against the *host's* injector, with the
 * host's providers and the host's build id. Anything the exposed component
 * needs from DI is something the host has to have configured, sight unseen.
 *
 * So the editor depends on no DI at all: it reads and writes persisted
 * envelopes, which are the same on both sides of the boundary by construction.
 * That is the contract between two independently deployed builds — not a
 * service, not an interface, the bytes in storage.
 */
export const appConfig: ApplicationConfig = {
  providers: [provideBrowserGlobalErrorListeners()],
};
