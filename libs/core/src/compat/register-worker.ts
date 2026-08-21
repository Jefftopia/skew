import { BraidError } from '../errors.js';

/**
 * Registering Braid's service worker, from the shell.
 *
 * This is the shell's job rather than the runtime's, and that is a deliberate line. Braid is
 * unopinionated about shells — prescribing one turns a library into a framework — so what ships here
 * is the *wiring*, not the shell: one call, with the failure modes named.
 *
 * Note the asymmetry with everything else in this package. A fragment must **not** register a
 * worker (compat realms refuse it, see `service-worker.ts`) because a fragment installing
 * origin-wide persistent state outlives the fragment. The host may, because the origin is the
 * host's.
 */

export interface RegisterBraidServiceWorkerOptions {
  /** Where the gateway serves the script. Matches `serviceWorker: true` on the gateway. */
  url?: string;
  /**
   * The scope to claim. Must be allowed by the script response's `Service-Worker-Allowed` header,
   * which is exactly what the gateway sends.
   */
  scope?: string;
  /**
   * Tell the worker what build this page is, so it can report disagreement.
   *
   * Sent as a message rather than baked into the script URL: a URL that changes per build is a new
   * worker every deploy, with a fresh install-and-wait lifecycle each time.
   */
  buildId?: string;
  snapshotId?: string;
  /** Called with the worker's answer, including any skew diagnosis. */
  onVersion?: (report: unknown) => void;
}

/**
 * Registers the worker and introduces the page to it.
 *
 * ```ts
 * import { registerBraidServiceWorker } from '@braid/core';
 * await registerBraidServiceWorker({ buildId: BUILD_ID });
 * ```
 *
 * Resolves to the registration, or `null` where service workers are unavailable — a non-secure
 * origin, a browser without them, or SSR. That is a `null` rather than a throw because a worker is
 * an enhancement: a page that works without one should not fail to start because it could not have
 * one.
 */
export async function registerBraidServiceWorker(
  options: RegisterBraidServiceWorkerOptions = {},
): Promise<ServiceWorkerRegistration | null> {
  const container = (globalThis as { navigator?: { serviceWorker?: ServiceWorkerContainer } }).navigator
    ?.serviceWorker;
  if (!container) return null;

  const url = options.url ?? '/__braid/sw.js';
  const scope = options.scope ?? '/';

  let registration: ServiceWorkerRegistration;
  try {
    registration = await container.register(url, { scope, type: 'module' });
  } catch (cause) {
    // The overwhelmingly common cause is the scope: a script at /__braid/sw.js may only claim '/'
    // if its response carried Service-Worker-Allowed, and a shell serving the script itself
    // (rather than through the gateway) usually has not configured that.
    throw new BraidError(`registering the Braid service worker at ${url} failed`, {
      fragmentId: 'braid-sw',
      stage: 'realm-boot',
      cause,
      fixHint:
        `the script response must send "Service-Worker-Allowed: ${scope}" — set serviceWorker: true ` +
        'on the gateway, which is the component that can send it',
    });
  }

  if (options.onVersion) {
    const listener = (event: MessageEvent) => {
      const data = event.data as { type?: string } | undefined;
      if (data?.type === 'braid-sw:version') options.onVersion?.(data);
    };
    container.addEventListener('message', listener as EventListener);
  }

  // The controller is what receives messages; a first-load registration has none until it activates
  // and takes over, so there is nobody to introduce the page to yet. The next navigation does it.
  container.controller?.postMessage({
    type: 'braid-sw:hello',
    page: {
      ...(options.buildId === undefined ? {} : { buildId: options.buildId }),
      ...(options.snapshotId === undefined ? {} : { snapshotId: options.snapshotId }),
    },
  });

  return registration;
}
