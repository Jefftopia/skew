import {
  withNativeFederation,
  shareAll,
} from '@angular-architects/native-federation/config';

export default withNativeFederation({
  name: 'prod-host',

  /**
   * Must match the remote's list exactly, or the "shared" singleton isn't one.
   * See the note in `apps/prod-remote/federation.config.mjs`.
   */
  sharedMappings: [
    '@skew/core',
    '@skew/angular-router',
    '@skew/angular-data',
    '@skew/angular-workflow',
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
