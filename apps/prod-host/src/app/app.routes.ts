import { Route } from '@angular/router';
import { loadRemote } from './load-remote';
import { PortfolioLive } from './portfolio/portfolio-live';

export const appRoutes: Route[] = [
  { path: '', pathMatch: 'full', redirectTo: 'basics' },

  {
    /**
     * Basics loads the remote's `./Editor` directly — no route for it. See
     * the comment on `remoteEditorType` in `basics-page.ts` for why: this tab
     * demonstrates the raw federation mechanic (fetch, retry, attribute a
     * failure), and routing would fold in a second concept — navigation and
     * recovery — that belongs to the Portfolio tab's fund detail route below.
     */
    path: 'basics',
    loadComponent: () =>
      import('./basics/basics-page').then((m) => m.BasicsPage),
  },

  {
    /**
     * `PortfolioLive` is provided here, not `providedIn: 'root'` — its
     * WebSocket and SSE connections should exist only while some portfolio
     * route is active, and close the moment the user leaves this subtree
     * (see its `DestroyRef.onDestroy`). A root-provided singleton would open
     * on first use and never close.
     */
    path: 'portfolio',
    providers: [PortfolioLive],
    loadComponent: () =>
      import('./portfolio/portfolio-layout').then((m) => m.PortfolioLayout),
    children: [
      {
        /**
         * The remote — a separately built, separately deployed application,
         * served from a different origin and resolved at runtime.
         *
         * Unlike Basics' inline `Editor`, this one *is* routed: browsing to a
         * specific fund is a real navigation with a real URL, and redeploying
         * the remote while this route is open is exactly the scenario
         * `SkewRecoveryService` exists for — retry, classify, reload at the
         * target. `'remote-fund-detail'` is the id the skew manifest keys on.
         *
         * It renders into the outlet *inside the drawer* (see
         * `portfolio-layout.ts`), so the fund list stays on screen beside it
         * rather than being replaced by it.
         */
        path: 'fund/:id',
        loadComponent: loadRemote(
          'remote-fund-detail',
          'prod-remote',
          './FundDetail',
          (m) => m['FundDetail'] as never,
        ),
      },
    ],
  },

  { path: '**', redirectTo: 'basics' },
];
