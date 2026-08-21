import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { SkewRecoveryService } from '@braid/angular-router';

/**
 * Shown when automatic recovery was NOT safe and the router degraded to
 * 'notify' instead of reloading. That happens when:
 *
 *   - the user has unsaved work registered via trackUnsavedWork()
 *     (respectUnsavedWork), or
 *   - the session's auto-recovery budget is spent (maxRecoveries), or
 *   - the origin probe says reloading can't help right now: `staleOrigin`
 *     (a CDN region still serving an index.html *older* than this client —
 *     reloading would loop) or `unreachable` (offline).
 *
 * The button calls SkewRecoveryService.recover(), which re-runs the same
 * classification before acting — so even a user-initiated recovery will not
 * be turned into a reload loop against a stale origin. The service, not
 * this component, owns that decision; keep it that way.
 *
 * Render this once in the app shell (e.g. at the top of app.component.html):
 *   <app-update-banner />
 */
@Component({
  selector: 'app-update-banner',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (recovery.pending()) {
      <div class="update-banner" role="status" aria-live="polite">
        <span class="update-banner__text">
          A new version of the app is available. Finish what you're doing,
          then reload to pick it up.
        </span>
        <button
          type="button"
          class="update-banner__action"
          (click)="recovery.recover()"
        >
          Reload now
        </button>
      </div>
    }
  `,
  styles: `
    .update-banner {
      position: sticky;
      top: 0;
      z-index: 1000;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 1rem;
      padding: 0.5rem 1rem;
      background: #1f2937;
      color: #f9fafb;
      font-size: 0.875rem;
    }

    .update-banner__action {
      flex: none;
      padding: 0.25rem 0.75rem;
      border: 1px solid currentColor;
      border-radius: 0.25rem;
      background: transparent;
      color: inherit;
      cursor: pointer;
    }
  `,
})
export class UpdateBannerComponent {
  // pending() is a signal: non-null while a recovery is waiting on the user.
  protected readonly recovery = inject(SkewRecoveryService);
}
