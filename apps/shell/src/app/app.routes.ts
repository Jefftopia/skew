import { Route } from '@angular/router';
import { lazy } from '@braidlabs/angular-router';
import { fakeChunkError, shouldFailNextChunk } from './simulator';

export const appRoutes: Route[] = [
  {
    path: '',
    pathMatch: 'full',
    loadComponent: () => import('./app-one/app-one').then((m) => m.AppOne),
  },
  {
    /**
     * "App 2" — a genuinely separate chunk, loaded by App 1.
     *
     * The `'app-two'` id is what lets recovery ask the manifest whether this
     * route still exists in the new build, rather than guessing.
     */
    path: 'app-two',
    loadComponent: lazy('app-two', async () => {
      // Stand-in for a purged asset. The rejection is deliberately raised
      // *inside* the loader so it takes the identical path a real 404 would.
      if (shouldFailNextChunk()) throw fakeChunkError();
      const m = await import('./app-two/app-two');
      return m.AppTwo;
    }),
  },
  { path: '**', redirectTo: '' },
];
