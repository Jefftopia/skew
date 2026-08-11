/**
 * app.routes.ts
 *
 * Nothing skew-specific here, and that is the point: @skew/angular-router
 * attaches to the router's navigation/loader error path via
 * provideSkewChunkRecovery() in app.config.ts, so lazy routes are written
 * exactly as stock Angular. No wrapping of import() calls, no custom
 * loadChildren helper to remember on every new route.
 */
import { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: 'admin',
    loadChildren: () => import('./admin/admin.routes').then(m => m.ADMIN_ROUTES),
  },
  {
    path: 'editor',
    loadChildren: () => import('./editor/editor.routes').then(m => m.EDITOR_ROUTES),
  },
  { path: '', pathMatch: 'full', redirectTo: 'admin' },
  { path: '**', redirectTo: 'admin' },
];
