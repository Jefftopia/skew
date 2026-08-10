import { Component, input, output } from '@angular/core';

/**
 * Two-pane layout: host content on the left, the remote in a drawer on the
 * right.
 *
 * Both demos previously put the remote on its own route, which meant the
 * host's screen *disappeared* the moment you went to look at the remote —
 * and every interesting thing about this project is a comparison between the
 * two. You cannot watch one build refuse what another build wrote if you can
 * only ever see one of them at a time.
 *
 * Content projects into two slots: default for the host pane, `[drawer]` for
 * the remote. The drawer is a plain grid column, not an overlay — an overlay
 * would put the remote *on top of* the host, which is the same "one at a
 * time" problem wearing a different hat.
 */
@Component({
  selector: 'host-drawer-shell',
  styleUrl: './drawer-shell.css',
  template: `
    <div class="workspace" [class.open]="open()">
      <div class="main">
        <ng-content />
      </div>

      <aside class="drawer" [attr.aria-hidden]="!open()">
        <div class="drawer-frame">
          <header class="drawer-head">
            <span class="drawer-tag">⬡ Remote</span>
            <span class="drawer-title">{{ title() }}</span>
            @if (closable()) {
              <button
                class="drawer-close"
                (click)="closed.emit()"
                aria-label="Close panel"
              >
                ×
              </button>
            }
          </header>
          <div class="drawer-body">
            <ng-content select="[drawer]" />
          </div>
        </div>
      </aside>
    </div>
  `,
})
export class DrawerShell {
  readonly open = input(false);
  readonly title = input('apps/prod-remote');
  readonly closable = input(false);
  readonly closed = output<void>();
}
