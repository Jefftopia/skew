import { Route } from '@angular/router';
import { loadRemote } from './load-remote';

export const appRoutes: Route[] = [
  {
    path: '',
    pathMatch: 'full',
    loadComponent: () => import('./home/home').then((m) => m.Home),
  },
  {
    /**
     * The remote — a separately built, separately deployed application, served
     * from a different origin and resolved at runtime.
     *
     * `'remote-editor'` is the id the skew manifest keys on.
     */
    path: 'editor',
    loadComponent: loadRemote(
      'remote-editor',
      'prod-remote',
      './Editor',
      (m) => m['Editor'] as never,
    ),
  },
  { path: '**', redirectTo: '' },
];
