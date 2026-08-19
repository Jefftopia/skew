import { Routes } from '@angular/router';
import { Home } from './home';
import { BillingPage } from './billing-page';
import { DemoPage } from './demo/demo-page';

export const routes: Routes = [
  { path: '', component: Home },
  { path: 'demo', component: DemoPage },
  // every /billing/* url renders the same host page; which billing screen appears inside the
  // fragment is the remote app's own routing decision
  { path: 'billing', component: BillingPage },
  { path: 'billing/:section', component: BillingPage },
];
