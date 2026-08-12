/**
 * recovery/chunk-recovery-banner.component.ts
 *
 * Shown ONLY when automatic recovery was possible to attempt but not safe to
 * perform. The two blocked states we render differently:
 *
 *   'guard-vetoed'  — a newer build exists at the origin, but the dirty-form
 *                     guard refused an automatic reload. The user can finish
 *                     what they're typing, then click "Reload now" (a
 *                     user-initiated reload is always allowed — the guard only
 *                     applies to *automatic* reloads).
 *
 *   'origin-stale'  — the origin/CDN region is still serving OUR buildId, so
 *                     a reload would loop. We do NOT offer "Reload now" as the
 *                     primary action here; we tell the user the truth ("the
 *                     update hasn't reached you yet") and offer "Try again",
 *                     which re-checks the manifest before deciding.
 *
 * Usage: drop <app-chunk-recovery-banner /> once into the root AppComponent
 * template, above <router-outlet />.
 *
 * Assumed @skewkit/angular-router runtime surface:
 *   SkewRecoveryService.blockedRecoveries — Signal<SkewBlockedRecovery | null>
 *     (buildId of the newer build if known, reason, failed route)
 *   SkewRecoveryService.reload()          — user-initiated reload; bypasses
 *                                           guards and the loop cap, but still
 *                                           refuses to reload into a same-
 *                                           buildId origin unless force: true.
 *   SkewRecoveryService.recheck()         — re-fetch manifest, re-attempt
 *                                           recovery under the normal rules.
 *   SkewRecoveryService.dismiss()         — clear the current blocked state.
 */
import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { SkewRecoveryService } from '@skewkit/angular-router';

@Component({
  selector: 'app-chunk-recovery-banner',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (blocked(); as b) {
      <div class="skew-banner" role="alert" aria-live="assertive">
        <div class="skew-banner__text">
          @if (b.reason === 'guard-vetoed') {
            <strong>A new version of the app is available.</strong>
            <span>
              We didn't refresh automatically because you have unsaved changes.
              Finish up, then reload to continue.
            </span>
          } @else if (b.reason === 'origin-stale') {
            <strong>Part of the app failed to load.</strong>
            <span>
              An update is rolling out but hasn't reached your region yet.
              Your work is untouched — try again in a moment.
            </span>
          } @else {
            <strong>Part of the app failed to load.</strong>
            <span>Check your connection, then try again.</span>
          }
        </div>

        <div class="skew-banner__actions">
          @if (b.reason === 'guard-vetoed') {
            <button type="button" class="skew-banner__btn skew-banner__btn--primary"
                    (click)="reloadNow()">
              Reload now
            </button>
          } @else {
            <button type="button" class="skew-banner__btn skew-banner__btn--primary"
                    (click)="tryAgain()">
              Try again
            </button>
          }
          <button type="button" class="skew-banner__btn" (click)="dismiss()">
            Dismiss
          </button>
        </div>
      </div>
    }
  `,
  styles: [`
    .skew-banner {
      position: fixed;
      inset: auto 0 0 0;
      z-index: 1000;
      display: flex;
      flex-wrap: wrap;
      gap: 0.75rem;
      align-items: center;
      justify-content: space-between;
      padding: 0.75rem 1rem;
      background: #1f2937;
      color: #f9fafb;
      box-shadow: 0 -2px 8px rgb(0 0 0 / 0.25);
      font-size: 0.875rem;
    }
    .skew-banner__text { display: flex; flex-direction: column; gap: 0.125rem; }
    .skew-banner__actions { display: flex; gap: 0.5rem; }
    .skew-banner__btn {
      padding: 0.375rem 0.875rem;
      border-radius: 0.375rem;
      border: 1px solid #6b7280;
      background: transparent;
      color: inherit;
      cursor: pointer;
    }
    .skew-banner__btn--primary {
      background: #2563eb;
      border-color: #2563eb;
      color: #fff;
    }
    .skew-banner__btn:focus-visible { outline: 2px solid #93c5fd; outline-offset: 2px; }
  `],
})
export class ChunkRecoveryBannerComponent {
  private readonly recovery = inject(SkewRecoveryService);

  /** null when there is nothing to show — the banner renders nothing. */
  protected readonly blocked = computed(() => this.recovery.blockedRecoveries());

  /**
   * Explicit user gesture: allowed to bypass the dirty-form guard (the user
   * has decided their draft is expendable) and the one-reload loop cap, but
   * SkewRecoveryService.reload() still refuses to reload into an origin that
   * is serving the same buildId — even a user click must not start a loop.
   */
  protected reloadNow(): void {
    void this.recovery.reload();
  }

  /** Re-run the manifest check; reloads only if a newer build has arrived. */
  protected tryAgain(): void {
    void this.recovery.recheck();
  }

  protected dismiss(): void {
    this.recovery.dismiss();
  }
}
