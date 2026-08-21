import { describe, expect, it, vi } from 'vitest';
import { navigationBus } from './navigation-bus.js';

const microtask = () => Promise.resolve();

describe('navigationBus', () => {
  it('should notify subscribers of host navigations synchronously and support unsubscribing', async () => {
    const subscriber = vi.fn();
    const unsubscribe = navigationBus.subscribe(subscriber);

    navigationBus.hostNavigationDetected();
    expect(subscriber).toHaveBeenCalledTimes(1);

    unsubscribe();
    await microtask();
    navigationBus.hostNavigationDetected();
    expect(subscriber).toHaveBeenCalledTimes(1);
  });

  it('should deliver a navigation detected by multiple sources exactly once', async () => {
    const subscriber = vi.fn();
    const unsubscribe = navigationBus.subscribe(subscriber);

    // e.g. the Navigation API and the onHostNavigation adapter both reporting the same pushState:
    // the first detection is delivered synchronously, duplicates are swallowed
    navigationBus.hostNavigationDetected();
    navigationBus.hostNavigationDetected();
    expect(subscriber).toHaveBeenCalledTimes(1);

    // a later navigation is delivered again
    await microtask();
    navigationBus.hostNavigationDetected();
    expect(subscriber).toHaveBeenCalledTimes(2);

    unsubscribe();
  });

  it('should suppress host navigation detection while a fragment navigation is being applied', async () => {
    const subscriber = vi.fn();
    const unsubscribe = navigationBus.subscribe(subscriber);

    const result = navigationBus.withFragmentNavigation(() => {
      // a Navigation API currententrychange event fired synchronously by the history mutation
      // must not be reported as a host navigation
      navigationBus.hostNavigationDetected();
      return 'applied';
    });

    expect(result).toBe('applied');
    expect(subscriber).not.toHaveBeenCalled();

    // detection resumes after the fragment navigation completes
    navigationBus.hostNavigationDetected();
    expect(subscriber).toHaveBeenCalledTimes(1);

    unsubscribe();
  });

  it('should deliver a detection that finds a new location, even inside the suppression window', async () => {
    // Routers report navigation in phases and the early ones fire before the URL changes
    // (Angular's NavigationStart). Suppressing by time alone would deliver the stale phase and
    // swallow the one that actually moved the page — fragments would lag a navigation behind.
    const subscriber = vi.fn();
    const unsubscribe = navigationBus.subscribe(subscriber);

    history.pushState(null, '', '/before');
    navigationBus.hostNavigationDetected();
    expect(subscriber).toHaveBeenCalledTimes(1);

    // same location again within the window: a duplicate report of one navigation
    navigationBus.hostNavigationDetected();
    expect(subscriber).toHaveBeenCalledTimes(1);

    // the URL has now actually moved — this must get through
    history.pushState(null, '', '/after');
    navigationBus.hostNavigationDetected();
    expect(subscriber).toHaveBeenCalledTimes(2);

    unsubscribe();
    await microtask();
  });

  it('should clear the suppression flag even when the navigation throws', () => {
    const subscriber = vi.fn();
    const unsubscribe = navigationBus.subscribe(subscriber);

    expect(() =>
      navigationBus.withFragmentNavigation(() => {
        throw new Error('boom');
      }),
    ).toThrow('boom');

    navigationBus.hostNavigationDetected();
    expect(subscriber).toHaveBeenCalledTimes(1);

    unsubscribe();
  });
});
