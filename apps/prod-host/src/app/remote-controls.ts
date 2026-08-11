import { Component, inject, input, output, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { API_BASE } from './portfolio/contracts';
import { Lab } from './lab';

interface RedeployResult {
  ok: boolean;
  buildId?: string;
  message: string;
}

/**
 * Redeploy the remote without leaving the page.
 *
 * The chunk-recovery scenario only exists if the remote is redeployed *while a
 * tab is open* — that is the entire premise. Until now that meant switching to
 * a terminal, finding the right shell, and running a script, all in the middle
 * of the thing you were supposed to be watching. Most people never did it, and
 * so never saw the failure the library is named after.
 *
 * The button posts to the API, which runs the same `tools/deploy-demo.mjs` the
 * npm script does. It is a genuine rebuild: new build id, new content hashes,
 * old files gone from disk. Nothing is faked, which is the only reason it is
 * worth having.
 */
@Component({
  selector: 'host-remote-controls',
  template: `
    <div class="card side-note">
      <h3>Redeploy the remote, right here</h3>
      <p>
        A real rebuild — new build id, new content hashes, the old files gone
        from disk. It runs the same <code>tools/deploy-demo.mjs</code> the npm
        script does, so you can stage the deploy-under-a-live-tab scenario
        without leaving the page.
      </p>

      <div class="controls">
        <button (click)="redeploy()" [disabled]="deploying()">
          {{ deploying() ? 'Rebuilding the remote…' : 'Redeploy the remote' }}
        </button>
        <button
          class="ghost"
          (click)="refetch.emit()"
          [disabled]="refetching()"
        >
          {{ refetching() ? 'Fetching…' : 'Re-mount the editor' }}
        </button>
      </div>

      <p class="hint">
        <strong
          >The editor beside you will not break, and that is not a bug.</strong
        >
        Native Federation resolves a remote once and caches the module for the
        life of the tab, so code already in memory cannot 404. The failure lands
        on the <em>first</em> load of a chunk after a redeploy — which is why
        the recovery scenario lives on the Portfolio tab. Redeploy here, then
        open a fund you have not opened yet, and watch
        <code>lazy()</code> retry, the manifest get probed, and the reload land
        on the fund you asked for.
      </p>

      @if (deployOutcome(); as o) {
        <div class="verdict" [class.ok]="o.ok" [class.bad]="!o.ok">
          <strong>{{ o.ok ? 'Remote redeployed' : 'Redeploy failed' }}</strong
          >{{ o.message }}
        </div>
      }

      @if (loadError(); as e) {
        <div class="verdict bad">
          <strong>Remote failed to load</strong>{{ e }}
        </div>
      }
    </div>
  `,
  styles: [
    `
      .controls {
        display: flex;
        gap: 0.5rem;
        flex-wrap: wrap;
      }
      .hint {
        margin: 0.6rem 0 0 !important;
        font-size: 0.72rem !important;
        color: #8b96a6 !important;
      }
    `,
  ],
})
export class RemoteControls {
  private readonly http = inject(HttpClient);
  private readonly lab = inject(Lab);

  readonly refetching = input(false);
  readonly loadError = input<string | null>(null);
  readonly refetch = output<void>();

  protected readonly deploying = signal(false);
  protected readonly deployOutcome = signal<RedeployResult | null>(null);

  protected async redeploy(): Promise<void> {
    this.deploying.set(true);
    this.deployOutcome.set(null);
    this.lab.write('step', 'deploy', 'POST /api/admin/redeploy-remote');

    try {
      const result = await firstValueFrom(
        this.http.post<RedeployResult>(`${API_BASE}/admin/redeploy-remote`, {}),
      );
      this.deployOutcome.set(result);
      this.lab.write(result.ok ? 'ok' : 'fail', 'deploy', result.message);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'The API did not respond. Is `npm run api` running?';
      this.deployOutcome.set({ ok: false, message });
      this.lab.write('fail', 'deploy', message);
    } finally {
      this.deploying.set(false);
    }
  }
}
