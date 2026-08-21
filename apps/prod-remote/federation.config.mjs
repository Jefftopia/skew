import {
  withNativeFederation,
  shareAll,
} from '@angular-architects/native-federation/config';

export default withNativeFederation({
  name: 'prod-remote',

  exposes: {
    './Editor': './apps/prod-remote/src/app/editor/editor.ts',
    './FundDetail': './apps/prod-remote/src/app/portfolio/fund-detail.ts',
    './Tutorials': './apps/prod-remote/src/app/tutorials/tutorials.ts',
  },

  /**
   * The `@braid/*` packages are workspace libraries reached through tsconfig
   * paths, not npm dependencies, so `shareAll` cannot see them. Without this,
   * each build would bundle its own copy — and `provideSkewWorkflow` in the
   * host would be writing to a different `InjectionToken` than the one
   * `injectWorkflow` reads from in the remote, which fails at runtime with a
   * "no provider" error that points nowhere useful.
   *
   * Sharing them as singletons is what makes the two bundles agree on identity
   * while still disagreeing, deliberately, about schema versions.
   */
  sharedMappings: [
    '@braid/skew',
    '@braid/angular-router',
    '@braid/angular-data',
    '@braid/angular-workflow',
  ],

  shared: {
    ...shareAll(
      {
        singleton: true,
        strictVersion: true,
        requiredVersion: 'auto',
        build: 'package',
      },
      {
        overrides: {
          '@angular/core': {
            singleton: true,
            strictVersion: true,
            requiredVersion: 'auto',
            build: 'package',
            includeSecondaries: { keepAll: true },
          },
        },
      },
    ),
  },

  skip: ['rxjs/ajax', 'rxjs/fetch', 'rxjs/testing', 'rxjs/webSocket'],

  features: {
    denseChunking: true,
  },
});
