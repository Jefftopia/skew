import { Component, Type, inject, signal } from '@angular/core';
import { NgComponentOutlet } from '@angular/common';
import { injectWorkflow } from '@skew/angular-workflow';
import { wizardV1 } from '../domain';
import { Lab } from '../lab';
import { loadRemote } from '../load-remote';
import { DrawerShell } from '../shell/drawer-shell';
import { BoundaryInspector } from '../boundary/boundary-inspector';
import { Walkthrough } from './walkthrough';
import { StorePanel } from '../store-panel';
import { RemoteControls } from '../remote-controls';

/**
 * The Basics tab: a guided round trip on the left, the live remote on the
 * right, and a diagram at the top that redraws after every step.
 *
 * The remote is loaded with `loadRemoteModule()` + `lazy()` and mounted with
 * `NgComponentOutlet` — no route. This tab is about the federation mechanic
 * itself (fetch a component from a build that did not exist when this page
 * was compiled, and render it); the routing-and-recovery story belongs to the
 * Portfolio tab, where navigating to a fund is a real navigation that a
 * redeploy can genuinely break.
 */
@Component({
  selector: 'host-basics-page',
  imports: [
    NgComponentOutlet,
    DrawerShell,
    BoundaryInspector,
    Walkthrough,
    StorePanel,
    RemoteControls,
  ],
  styleUrls: ['../cards.css', './basics-page.css'],
  template: `
    <host-drawer-shell [open]="true" title="apps/prod-remote · ./Editor">
      <!-- ── host pane ── -->
      <host-boundary-inspector />
      <host-walkthrough />
      <host-store-panel />

      <div class="card side-note">
        <h3>A draft caught mid-wizard</h3>
        <p>
          A second, quieter version of the same problem, from
          <code>&#64;skew/angular-workflow</code>. Type below — the host's
          wizard is 0.1, two steps, no review. The remote ships 0.2, which
          inserted a <code>review</code> step and added a field. Read the parked
          draft in the panel on the right and watch it migrate.
        </p>
        <div class="wizard">
          <input
            placeholder="Title"
            [value]="flow.data().title"
            (input)="flow.patch({ title: $any($event.target).value })"
          />
          <input
            placeholder="Body"
            [value]="flow.data().body"
            (input)="flow.patch({ body: $any($event.target).value })"
          />
          <div class="step">
            parked on <strong>{{ flow.current() }}</strong> ·
            {{ flow.progress().done }}/{{ flow.progress().total }} · draft
            <strong>{{ flow.savedLocally() }}</strong>
          </div>
        </div>
      </div>

      <host-remote-controls
        [refetching]="remoteLoading()"
        [loadError]="remoteLoadError()"
        (refetch)="loadEditorInline()"
      />

      <!-- ── remote pane ── -->
      <div drawer>
        @if (remoteEditorType(); as C) {
          <ng-container *ngComponentOutlet="C" />
        } @else if (remoteLoadError(); as e) {
          <div class="verdict bad">
            <strong>Remote failed to load</strong>{{ e }}
          </div>
        } @else {
          <p class="step">Fetching the remote…</p>
        }
      </div>
    </host-drawer-shell>
  `,
})
export class BasicsPage {
  protected readonly lab = inject(Lab);
  protected readonly flow = injectWorkflow(wizardV1);

  protected readonly remoteEditorType = signal<Type<unknown> | null>(null);
  protected readonly remoteLoadError = signal<string | null>(null);
  protected readonly remoteLoading = signal(false);

  /**
   * The same helper the routed fund-detail page uses, called as a plain
   * function rather than handed to `loadComponent`. `lazy()`'s retry and
   * attribution are router-independent; only the *recovery decision* needs a
   * navigation to hang off, and this tab deliberately does not reach for it.
   */
  private readonly loadEditor = loadRemote(
    'remote-editor',
    'prod-remote',
    './Editor',
    (m) => m['Editor'] as never,
  );

  constructor() {
    void this.loadEditorInline();
  }

  protected async loadEditorInline(): Promise<void> {
    this.remoteLoading.set(true);
    this.remoteLoadError.set(null);
    try {
      const Editor = await this.loadEditor();
      this.remoteEditorType.set(Editor as Type<unknown>);
      this.lab.write('ok', 'federation', 'remote Editor mounted in the drawer');
    } catch (error) {
      this.remoteEditorType.set(null);
      const message = error instanceof Error ? error.message : String(error);
      this.lab.write('fail', 'federation', `remote load failed: ${message}`);
      this.remoteLoadError.set(message);
    } finally {
      this.remoteLoading.set(false);
    }
  }
}
