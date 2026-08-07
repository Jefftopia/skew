import { DOCUMENT, Injectable, PLATFORM_ID, computed, inject, signal } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { NavigationError, Router } from '@angular/router';
import {
  type SkewStatus,
  type VersionProbe,
  createVersionProbe,
  moduleWasRemoved,
} from '@skew/core';
import {
  type PendingSkew,
  SKEW_RECOVERY_OPTIONS,
  type StaleChunkAction,
  type StaleChunkContext,
} from './config';
import { ChunkLoadFailure, isChunkLoadFailure } from './lazy';
import { UnsavedWorkRegistry } from './unsaved-work';

const LOOP_GUARD_KEY = 'skew:recoveries';

/**
 * Orchestrates recovery from a failed lazy load.
 *
 * Wiring is via router events rather than a global registry: `lazy()` throws a
 * {@link ChunkLoadFailure}, Angular surfaces it as `NavigationError`, and this
 * service recognises it there. That keeps `lazy()` dependency-free and usable
 * in route definitions, which are evaluated long before DI exists.
 *
 * Zoneless-safe and SSR-safe: no `NgZone`, and every `location` /
 * `sessionStorage` touch is guarded.
 */
@Injectable({ providedIn: 'root' })
export class SkewRecoveryService {
  private readonly options = inject(SKEW_RECOVERY_OPTIONS);
  private readonly router = inject(Router);
  private readonly document = inject(DOCUMENT);
  private readonly unsavedWork = inject(UnsavedWorkRegistry);
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

  private readonly probe: VersionProbe | null;

  private readonly pendingSignal = signal<PendingSkew | null>(null);
  private readonly statusSignal = signal<SkewStatus | null>(null);

  /** A recovery the application has been asked to complete itself. */
  readonly pending = this.pendingSignal.asReadonly();
  /** Last known comparison against the origin. */
  readonly status = this.statusSignal.asReadonly();
  /** True when a newer deployment is known to exist. */
  readonly updateAvailable = computed(() => this.statusSignal()?.kind === 'staleClient');

  constructor() {
    this.probe = this.options.manifestUrl
      ? createVersionProbe({
          identity: this.options.identity,
          manifestUrl: this.options.manifestUrl,
        })
      : null;

    if (this.isBrowser) this.listen();
  }

  private listen(): void {
    this.router.events.subscribe((event) => {
      if (event instanceof NavigationError && isChunkLoadFailure(event.error)) {
        void this.handle(event.error, event.url);
      }
    });
  }

  /** Re-checks the origin. Safe to call from a "check for updates" control. */
  async check(): Promise<SkewStatus | null> {
    if (!this.probe) return null;
    const status = await this.probe.check();
    this.statusSignal.set(status);
    return status;
  }

  /** Completes a deferred recovery — what a "Reload" button calls. */
  recover(): void {
    const pending = this.pendingSignal();
    if (!pending) return;
    this.pendingSignal.set(null);
    this.assign(pending.targetUrl);
  }

  /** Dismisses a pending recovery without acting on it. */
  dismiss(): void {
    this.pendingSignal.set(null);
  }

  private async handle(failure: ChunkLoadFailure, targetUrl: string): Promise<void> {
    const context = await this.classify(failure, targetUrl);
    const action = await this.chooseAction(context);
    this.dispatch(action, context);
  }

  private async classify(
    failure: ChunkLoadFailure,
    targetUrl: string,
  ): Promise<StaleChunkContext> {
    const status = await this.check();

    const serverBuildId =
      status?.kind === 'current'
        ? status.buildId
        : status && 'remote' in status
          ? status.remote
          : undefined;

    // Absent a module map we must assume the route still exists. Claiming it
    // was deleted would redirect users away from a route that merely moved —
    // a worse failure than the one being recovered from.
    const manifest = this.probe?.lastManifest() ?? null;
    const moduleStillExists =
      failure.moduleId === undefined ||
      manifest === null ||
      !moduleWasRemoved(manifest, failure.moduleId);

    return {
      targetUrl,
      currentUrl: this.router.url,
      moduleId: failure.moduleId,
      error: failure,
      attempt: this.recoveryCount(),
      isOnline: this.isOnline(),
      clientBuildId: this.options.identity.buildId,
      serverBuildId,
      moduleStillExists,
      entryDocumentStale: status?.kind === 'staleOrigin',
      newAssetsReachable: status?.kind === 'staleClient',
      hasUnsavedWork: this.options.respectUnsavedWork && this.unsavedWork.isDirty(),
    };
  }

  private async chooseAction(context: StaleChunkContext): Promise<StaleChunkAction> {
    // Guard rails run before any application policy, because each of these is a
    // case where reloading is actively harmful rather than merely unhelpful.
    if (!context.isOnline) return 'notify';
    if (context.entryDocumentStale) return 'notify'; // reloading would loop
    if (context.attempt >= this.options.maxRecoveries) return 'notify';
    if (context.hasUnsavedWork) return 'notify';
    if (!context.moduleStillExists) return 'redirect-to-fallback';

    const strategy = this.options.onStaleChunk;
    if (typeof strategy === 'function') {
      try {
        return await strategy(context);
      } catch {
        // A throwing policy must not strand the user with nothing.
        return 'notify';
      }
    }
    return strategy;
  }

  private dispatch(action: StaleChunkAction, context: StaleChunkContext): void {
    switch (action) {
      case 'reload-at-target':
        this.countRecovery();
        this.assign(context.targetUrl);
        return;
      case 'reload-in-place':
        this.countRecovery();
        this.reload();
        return;
      case 'redirect-to-fallback':
        void this.router.navigateByUrl(this.options.fallbackRoute);
        return;
      case 'ignore':
        return;
      case 'notify':
        this.pendingSignal.set({
          targetUrl: context.targetUrl,
          moduleId: context.moduleId,
          serverBuildId: context.serverBuildId,
          reason: !context.isOnline
            ? 'offline'
            : context.entryDocumentStale
              ? 'loop-detected'
              : context.attempt >= this.options.maxRecoveries
                ? 'exhausted'
                : 'notify',
          context,
        });
        return;
    }
  }

  // --- environment access, all browser-guarded ---------------------------

  private isOnline(): boolean {
    if (!this.isBrowser) return true;
    const nav = this.document.defaultView?.navigator;
    return nav?.onLine ?? true;
  }

  private assign(url: string): void {
    if (!this.isBrowser) return;
    this.document.defaultView?.location.assign(url);
  }

  private reload(): void {
    if (!this.isBrowser) return;
    this.document.defaultView?.location.reload();
  }

  /**
   * Recoveries already attempted, kept in `sessionStorage` so it survives the
   * very reload it is counting. Without this, an origin serving a stale entry
   * document turns one failure into an infinite reload loop.
   */
  private recoveryCount(): number {
    if (!this.isBrowser) return 0;
    try {
      const raw = this.document.defaultView?.sessionStorage.getItem(LOOP_GUARD_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      // Scoped to a build: a genuinely new deployment gets a fresh budget.
      return parsed?.buildId === this.options.identity.buildId ? (parsed.count ?? 0) : 0;
    } catch {
      return 0;
    }
  }

  private countRecovery(): void {
    if (!this.isBrowser) return;
    try {
      this.document.defaultView?.sessionStorage.setItem(
        LOOP_GUARD_KEY,
        JSON.stringify({ buildId: this.options.identity.buildId, count: this.recoveryCount() + 1 }),
      );
    } catch {
      // Private mode. The manifest probe remains as the precise loop guard.
    }
  }
}
