import { DOCUMENT, PLATFORM_ID } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { NavigationError, Router } from '@angular/router';
import { Subject } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SKEW_RECOVERY_OPTIONS,
  resolveOptions,
  type StaleChunkContext,
  type StaleChunkStrategy,
} from './config';
import { ChunkLoadFailure } from './lazy';
import { SkewRecoveryService } from './recovery.service';
import { UnsavedWorkRegistry } from './unsaved-work';

/**
 * The service is exercised through its real collaborators (router events,
 * DOCUMENT, sessionStorage) rather than by calling private methods, because
 * the behaviour that matters is precisely the wiring.
 */

const CLIENT = { buildId: 'client-1', builtAt: '2026-08-01T00:00:00Z' };

interface Harness {
  events: Subject<unknown>;
  assign: ReturnType<typeof vi.fn>;
  reload: ReturnType<typeof vi.fn>;
  navigateByUrl: ReturnType<typeof vi.fn>;
  session: Map<string, string>;
  service: SkewRecoveryService;
}

function setup(config: {
  strategy?: StaleChunkStrategy;
  manifest?: unknown;
  fetchFails?: boolean;
  online?: boolean;
  maxRecoveries?: number;
  priorRecoveries?: number;
  dirty?: boolean;
} = {}): Harness {
  const events = new Subject<unknown>();
  const assign = vi.fn();
  const reload = vi.fn();
  const navigateByUrl = vi.fn();
  const session = new Map<string, string>();

  if (config.priorRecoveries) {
    session.set(
      'skew:recoveries',
      JSON.stringify({ buildId: CLIENT.buildId, count: config.priorRecoveries }),
    );
  }

  globalThis.fetch = vi.fn(async () => {
    if (config.fetchFails) throw new Error('offline');
    return {
      ok: true,
      status: 200,
      json: async () => config.manifest ?? { buildId: CLIENT.buildId },
    } as unknown as Response;
  }) as never;

  const documentStub = {
    defaultView: {
      navigator: { onLine: config.online ?? true },
      location: { assign, reload },
      sessionStorage: {
        getItem: (k: string) => session.get(k) ?? null,
        setItem: (k: string, v: string) => void session.set(k, v),
        removeItem: (k: string) => void session.delete(k),
      },
    },
  };

  TestBed.configureTestingModule({
    providers: [
      { provide: PLATFORM_ID, useValue: 'browser' },
      { provide: DOCUMENT, useValue: documentStub },
      { provide: Router, useValue: { events, url: '/current', navigateByUrl } },
      {
        provide: SKEW_RECOVERY_OPTIONS,
        useValue: resolveOptions({
          identity: CLIENT,
          manifestUrl: '/skew-manifest.json',
          onStaleChunk: config.strategy ?? 'reload-at-target',
          maxRecoveries: config.maxRecoveries ?? 1,
        }),
      },
    ],
  });

  const service = TestBed.inject(SkewRecoveryService);
  if (config.dirty) TestBed.inject(UnsavedWorkRegistry).register(() => true);

  return { events, assign, reload, navigateByUrl, session, service };
}

/** Emits a failed navigation and lets the async classification settle. */
async function failNavigation(h: Harness, moduleId = 'admin.routes', url = '/admin'): Promise<void> {
  h.events.next(new NavigationError(1, url, new ChunkLoadFailure(moduleId, new Error('404'), 1)));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => TestBed.resetTestingModule());

describe('SkewRecoveryService', () => {
  it('reloads at the attempted URL, not the current one', async () => {
    // The distinction that matters: urlUpdateStrategy is 'deferred', so the
    // address bar still shows /current after the failure.
    const h = setup({ manifest: { buildId: 'server-2', builtAt: '2026-08-02T00:00:00Z' } });

    await failNavigation(h, 'admin.routes', '/admin');

    expect(h.assign).toHaveBeenCalledWith('/admin');
    expect(h.reload).not.toHaveBeenCalled();
  });

  it('ignores navigation errors that are not chunk failures', async () => {
    const h = setup();

    h.events.next(new NavigationError(1, '/admin', new Error('guard rejected')));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(h.assign).not.toHaveBeenCalled();
    expect(h.service.pending()).toBeNull();
  });

  describe('guard rails', () => {
    it('does not reload when the origin is older than us — that would loop', async () => {
      const h = setup({ manifest: { buildId: 'server-0', builtAt: '2026-07-01T00:00:00Z' } });

      await failNavigation(h);

      expect(h.assign).not.toHaveBeenCalled();
      expect(h.service.pending()?.reason).toBe('loop-detected');
    });

    it('does not reload while offline', async () => {
      const h = setup({ online: false, fetchFails: true });

      await failNavigation(h);

      expect(h.assign).not.toHaveBeenCalled();
      expect(h.service.pending()?.reason).toBe('offline');
    });

    it('stops after the recovery budget is spent', async () => {
      const h = setup({
        manifest: { buildId: 'server-2', builtAt: '2026-08-02T00:00:00Z' },
        maxRecoveries: 1,
        priorRecoveries: 1,
      });

      await failNavigation(h);

      expect(h.assign).not.toHaveBeenCalled();
      expect(h.service.pending()?.reason).toBe('exhausted');
    });

    it('does not discard unsaved work', async () => {
      const h = setup({
        manifest: { buildId: 'server-2', builtAt: '2026-08-02T00:00:00Z' },
        dirty: true,
      });

      await failNavigation(h);

      expect(h.assign).not.toHaveBeenCalled();
      expect(h.service.pending()).not.toBeNull();
    });

    it('redirects instead of reloading when the route was deleted', async () => {
      const h = setup({
        manifest: {
          buildId: 'server-2',
          builtAt: '2026-08-02T00:00:00Z',
          modules: { 'home.routes': { file: 'home-abc.js' } },
        },
      });

      await failNavigation(h, 'admin.routes');

      expect(h.navigateByUrl).toHaveBeenCalledWith('/');
      expect(h.assign).not.toHaveBeenCalled();
    });

    it('assumes the route survives when the manifest has no module map', async () => {
      const h = setup({ manifest: { buildId: 'server-2', builtAt: '2026-08-02T00:00:00Z' } });

      await failNavigation(h, 'admin.routes');

      expect(h.assign).toHaveBeenCalledWith('/admin');
      expect(h.navigateByUrl).not.toHaveBeenCalled();
    });
  });

  describe('loop counter', () => {
    it('persists across the reload it is counting', async () => {
      const h = setup({ manifest: { buildId: 'server-2', builtAt: '2026-08-02T00:00:00Z' } });

      await failNavigation(h);

      const stored = JSON.parse(h.session.get('skew:recoveries') as string);
      expect(stored).toEqual({ buildId: CLIENT.buildId, count: 1 });
    });

    it('gives a genuinely new build a fresh budget', async () => {
      const h = setup({
        manifest: { buildId: 'server-2', builtAt: '2026-08-02T00:00:00Z' },
        maxRecoveries: 1,
      });
      // A counter left over from a different build must not block recovery.
      h.session.set('skew:recoveries', JSON.stringify({ buildId: 'some-older-build', count: 9 }));

      await failNavigation(h);

      expect(h.assign).toHaveBeenCalledWith('/admin');
    });
  });

  describe('strategies', () => {
    it('honours reload-in-place', async () => {
      const h = setup({
        strategy: 'reload-in-place',
        manifest: { buildId: 'server-2', builtAt: '2026-08-02T00:00:00Z' },
      });

      await failNavigation(h);

      expect(h.reload).toHaveBeenCalled();
      expect(h.assign).not.toHaveBeenCalled();
    });

    it('honours ignore', async () => {
      const h = setup({
        strategy: 'ignore',
        manifest: { buildId: 'server-2', builtAt: '2026-08-02T00:00:00Z' },
      });

      await failNavigation(h);

      expect(h.assign).not.toHaveBeenCalled();
      expect(h.service.pending()).toBeNull();
    });

    it('passes a populated context to a custom strategy', async () => {
      const strategy = vi.fn((_context: StaleChunkContext) => 'notify' as const);
      const h = setup({
        strategy,
        manifest: { buildId: 'server-2', builtAt: '2026-08-02T00:00:00Z' },
      });

      await failNavigation(h, 'admin.routes', '/admin');

      expect(strategy).toHaveBeenCalledOnce();
      const context = strategy.mock.calls[0]?.[0] as unknown as Record<string, unknown>;
      expect(context['targetUrl']).toBe('/admin');
      expect(context['currentUrl']).toBe('/current');
      expect(context['moduleId']).toBe('admin.routes');
      expect(context['clientBuildId']).toBe('client-1');
      expect(context['serverBuildId']).toBe('server-2');
      expect(context['newAssetsReachable']).toBe(true);
    });

    it('falls back to notify when a custom strategy throws', async () => {
      const h = setup({
        strategy: () => {
          throw new Error('policy bug');
        },
        manifest: { buildId: 'server-2', builtAt: '2026-08-02T00:00:00Z' },
      });

      await failNavigation(h);

      expect(h.service.pending()).not.toBeNull();
      expect(h.assign).not.toHaveBeenCalled();
    });
  });

  describe('deferred recovery', () => {
    it('completes on recover()', async () => {
      const h = setup({
        strategy: 'notify',
        manifest: { buildId: 'server-2', builtAt: '2026-08-02T00:00:00Z' },
      });
      await failNavigation(h);
      expect(h.service.pending()).not.toBeNull();

      h.service.recover();

      expect(h.assign).toHaveBeenCalledWith('/admin');
      expect(h.service.pending()).toBeNull();
    });

    it('clears on dismiss() without navigating', async () => {
      const h = setup({
        strategy: 'notify',
        manifest: { buildId: 'server-2', builtAt: '2026-08-02T00:00:00Z' },
      });
      await failNavigation(h);

      h.service.dismiss();

      expect(h.service.pending()).toBeNull();
      expect(h.assign).not.toHaveBeenCalled();
    });

    it('is a no-op when nothing is pending', () => {
      const h = setup();
      h.service.recover();
      expect(h.assign).not.toHaveBeenCalled();
    });
  });

  it('exposes updateAvailable when the origin is ahead', async () => {
    const h = setup({ manifest: { buildId: 'server-2', builtAt: '2026-08-02T00:00:00Z' } });

    await h.service.check();

    expect(h.service.updateAvailable()).toBe(true);
    expect(h.service.status()?.kind).toBe('staleClient');
  });
});

describe('server-side rendering', () => {
  it('never touches location or subscribes to events', () => {
    const events = new Subject<unknown>();
    const assign = vi.fn();

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: PLATFORM_ID, useValue: 'server' },
        { provide: DOCUMENT, useValue: { defaultView: { location: { assign } } } },
        { provide: Router, useValue: { events, url: '/', navigateByUrl: vi.fn() } },
        {
          provide: SKEW_RECOVERY_OPTIONS,
          useValue: resolveOptions({ identity: CLIENT }),
        },
      ],
    });

    const service = TestBed.inject(SkewRecoveryService);
    events.next(new NavigationError(1, '/admin', new ChunkLoadFailure('a', new Error('x'), 1)));

    expect(assign).not.toHaveBeenCalled();
    expect(service.pending()).toBeNull();
  });
});
