import { bootstrapApplication } from '@angular/platform-browser';
import { provideBraid } from '@braid/angular';
import { App } from './app/app';
import { appConfig } from './app/app.config';

bootstrapApplication(App, {
  providers: [
    ...appConfig.providers,

    /**
     * The entire host-side integration.
     *
     * `provideBraid()` initializes the runtime and subscribes to the router's *after*-navigation
     * events, so bound fragments follow host navigation. Braid never patches the host's History
     * API — host purity is an invariant — which is why that callback exists at all.
     */
    provideBraid({ dev: true }),
  ],
}).catch((error) => console.error(error));
