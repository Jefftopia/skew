import { Routes } from '@angular/router';
import { Invoices } from './invoices';
import { Settings } from './settings';

/**
 * The remote's own routes, written exactly as they would be if this app were deployed on its
 * own at `/billing/*`. Nothing here knows it is being composed into another application.
 */
export const routes: Routes = [
  { path: 'billing/invoices', component: Invoices },
  { path: 'billing/settings', component: Settings },
  { path: 'billing', redirectTo: 'billing/invoices', pathMatch: 'full' },
  { path: '**', redirectTo: 'billing/invoices' },
];
