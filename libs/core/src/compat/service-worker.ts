import { BraidError } from '../errors.js';
import { isDevMode } from '../config.js';

/**
 * Service worker containment for compat realms.
 *
 * A realm's `navigator` is aliased to the host window's, so without this a fragment reaches the
 * host page's real `ServiceWorkerContainer` — and `register()` installs a **persistent worker on
 * the host's origin** that outlives the fragment's unmount, because `env.signal` teardown has
 * nothing to unregister it with.
 *
 * The invariants had a hole here worth naming. Host purity says *Braid* never patches the host;
 * nothing said anything about a *fragment* installing origin-wide persistent state. Realm isolation
 * covers JavaScript, and a service worker is neither JavaScript state nor scoped to a realm — it is
 * infrastructure attached to the origin.
 *
 * So registration is refused, loudly. A fragment that wants offline behavior should get it from the
 * host's worker rather than installing a second one, and two workers racing for one scope is a
 * debugging problem nobody should inherit by accident.
 *
 * The container stays *present* rather than being deleted: `'serviceWorker' in navigator` is how
 * every app feature-detects, and answering false would make an app that genuinely needs a worker
 * degrade in silence instead of saying so.
 */
export function createRealmNavigator(hostNavigator: Navigator, fragmentId: string): Navigator {
  const container = createContainmentContainer(fragmentId);

  return new Proxy(hostNavigator, {
    get(target, property, receiver) {
      if (property === 'serviceWorker') return container;

      const value = Reflect.get(target, property, target);
      // Navigator members are natively bound to the real navigator; handing back an unbound
      // function would make `navigator.sendBeacon(...)` throw an illegal-invocation error.
      return typeof value === 'function' ? value.bind(target) : value;
    },

    // `navigator.serviceWorker = x` is silently ignored by the platform (the property has no
    // setter); mirroring that is more predictable than throwing.
    set(target, property, value, receiver) {
      if (property === 'serviceWorker') return true;
      return Reflect.set(target, property, value, receiver);
    },

    has(target, property) {
      return property === 'serviceWorker' || Reflect.has(target, property);
    },
  });
}

function createContainmentContainer(fragmentId: string): ServiceWorkerContainer {
  const refuse = (operation: string) =>
    new BraidError(`a fragment may not ${operation} a service worker`, {
      fragmentId,
      stage: 'realm-boot',
      fixHint:
        'a service worker attaches to the whole origin, outlives this fragment, and is not scoped ' +
        'by the realm — so the shell must own it. Register it from the host and let this fragment ' +
        "share it, or drop the registration if the fragment's offline behavior is not needed here.",
    });

  const report = (operation: string) => {
    if (isDevMode()) {
      console.warn(
        `[braid:${fragmentId}] refused to ${operation} a service worker. Registration would install ` +
          `origin-wide persistent state that survives this fragment's unmount; the shell owns the worker.`,
      );
    }
  };

  const target = new EventTarget();

  const container = {
    async register(): Promise<ServiceWorkerRegistration> {
      report('register');
      throw refuse('register');
    },

    /**
     * Empty rather than the host's registrations.
     *
     * Reporting them would tell a fragment what else is installed on the origin — the host's
     * infrastructure is not the fragment's business, and a fragment acting on a registration it
     * did not create is a worse outcome than one that sees none.
     */
    async getRegistration(): Promise<ServiceWorkerRegistration | undefined> {
      return undefined;
    },
    async getRegistrations(): Promise<readonly ServiceWorkerRegistration[]> {
      return [];
    },

    /**
     * Rejected, which is a deliberate deviation: the spec leaves `ready` pending forever when there
     * is no registration. A promise that never settles is indistinguishable from a hang, and in an
     * emulation layer an honest error beats a spec-accurate silence.
     */
    get ready(): Promise<ServiceWorkerRegistration> {
      report('await readiness of');
      return Promise.reject(refuse('use'));
    },

    get controller(): ServiceWorker | null {
      return null;
    },

    startMessages(): void {
      // no worker, so no messages to start delivering
    },

    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    dispatchEvent: target.dispatchEvent.bind(target),

    oncontrollerchange: null,
    onmessage: null,
    onmessageerror: null,
  };

  return container as unknown as ServiceWorkerContainer;
}
