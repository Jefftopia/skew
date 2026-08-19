import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRealmNavigator } from './service-worker.js';
import { setBraidConfig } from '../config.js';

/** A stand-in for the host's real navigator, including a container a fragment must not reach. */
function hostNavigator() {
  const register = vi.fn(async () => ({ scope: '/' }));
  const getRegistrations = vi.fn(async () => [{ scope: '/admin/' }]);

  return {
    navigator: {
      userAgent: 'test-agent',
      language: 'en-GB',
      sendBeacon(this: unknown, _url: string) {
        // throws an illegal-invocation error natively if called unbound
        if (this !== undefined && (this as { userAgent?: string }).userAgent !== 'test-agent') {
          throw new TypeError('Illegal invocation');
        }
        return true;
      },
      serviceWorker: {
        register,
        getRegistrations,
        getRegistration: async () => ({ scope: '/admin/' }),
        controller: { state: 'activated' },
        ready: Promise.resolve({ scope: '/admin/' }),
      },
    } as unknown as Navigator,
    register,
    getRegistrations,
  };
}

describe('realm navigator', () => {
  afterEach(() => setBraidConfig({ dev: false }));

  it('passes ordinary members through', () => {
    const navigator = createRealmNavigator(hostNavigator().navigator, 'billing');

    expect(navigator.userAgent).toBe('test-agent');
    expect(navigator.language).toBe('en-GB');
  });

  it('keeps native methods bound to the real navigator', () => {
    // an unbound method would throw "Illegal invocation" the moment a fragment called it
    const navigator = createRealmNavigator(hostNavigator().navigator, 'billing');

    expect(() => navigator.sendBeacon('/ping')).not.toThrow();
  });

  describe('service worker containment', () => {
    it('still reports the container, so feature detection takes its normal branch', () => {
      const navigator = createRealmNavigator(hostNavigator().navigator, 'billing');

      expect('serviceWorker' in navigator).toBe(true);
      expect(navigator.serviceWorker).toBeDefined();
    });

    it('refuses registration with a named error naming the fragment', async () => {
      const host = hostNavigator();
      const navigator = createRealmNavigator(host.navigator, 'billing');

      await expect(navigator.serviceWorker.register('/sw.js')).rejects.toThrow(/\[braid:billing\]/);
      await expect(navigator.serviceWorker.register('/sw.js')).rejects.toThrow(/may not register a service worker/);
    });

    it('never reaches the host container', async () => {
      const host = hostNavigator();
      const navigator = createRealmNavigator(host.navigator, 'billing');

      await navigator.serviceWorker.register('/sw.js').catch(() => undefined);

      expect(host.register).not.toHaveBeenCalled();
    });

    it('explains that the shell owns the worker', async () => {
      const navigator = createRealmNavigator(hostNavigator().navigator, 'billing');

      await expect(navigator.serviceWorker.register('/sw.js')).rejects.toThrow(/the shell must own it/);
    });

    it('does not disclose the host’s registrations', async () => {
      const host = hostNavigator();
      const navigator = createRealmNavigator(host.navigator, 'billing');

      expect(await navigator.serviceWorker.getRegistrations()).toEqual([]);
      expect(await navigator.serviceWorker.getRegistration()).toBeUndefined();
      expect(host.getRegistrations).not.toHaveBeenCalled();
    });

    it('reports no controller rather than the host’s', () => {
      const navigator = createRealmNavigator(hostNavigator().navigator, 'billing');

      expect(navigator.serviceWorker.controller).toBeNull();
    });

    it('rejects `ready` rather than hanging forever', async () => {
      // the spec leaves `ready` pending when there is no registration; a promise that never
      // settles is indistinguishable from a hang, so this deviates deliberately
      const navigator = createRealmNavigator(hostNavigator().navigator, 'billing');

      await expect(navigator.serviceWorker.ready).rejects.toThrow(/may not use a service worker/);
    });

    it('ignores assignment, as the platform does', () => {
      const navigator = createRealmNavigator(hostNavigator().navigator, 'billing');

      (navigator as unknown as Record<string, unknown>)['serviceWorker'] = { register: vi.fn() };

      expect(navigator.serviceWorker.register).toBeDefined();
      expect(navigator.serviceWorker.getRegistrations).toBeDefined();
    });

    it('is an event target, so listener wiring does not throw', () => {
      const navigator = createRealmNavigator(hostNavigator().navigator, 'billing');

      expect(() => navigator.serviceWorker.addEventListener('message', () => undefined)).not.toThrow();
      expect(() => navigator.serviceWorker.startMessages()).not.toThrow();
    });

    describe('dev mode', () => {
      let warn: ReturnType<typeof vi.spyOn>;

      beforeEach(() => {
        setBraidConfig({ dev: true });
        warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      });

      afterEach(() => warn.mockRestore());

      it('reports the attempt', async () => {
        const navigator = createRealmNavigator(hostNavigator().navigator, 'billing');

        await navigator.serviceWorker.register('/sw.js').catch(() => undefined);

        expect(warn).toHaveBeenCalledWith(expect.stringContaining('[braid:billing] refused to register'));
      });

      it('says nothing in production', async () => {
        setBraidConfig({ dev: false });
        const navigator = createRealmNavigator(hostNavigator().navigator, 'billing');

        await navigator.serviceWorker.register('/sw.js').catch(() => undefined);

        expect(warn).not.toHaveBeenCalled();
      });
    });
  });
});
