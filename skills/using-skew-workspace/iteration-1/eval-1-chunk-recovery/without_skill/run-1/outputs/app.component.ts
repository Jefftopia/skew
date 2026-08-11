/**
 * app.component.ts — root shell, showing where the recovery banner mounts.
 * One instance, at the root, outside the router outlet, so it survives the
 * very navigation failures it reports on.
 */
import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { ChunkRecoveryBannerComponent } from './recovery/chunk-recovery-banner.component';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, ChunkRecoveryBannerComponent],
  template: `
    <router-outlet />
    <app-chunk-recovery-banner />
  `,
})
export class AppComponent {}
