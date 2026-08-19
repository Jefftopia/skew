import { bootstrapApplication } from '@angular/platform-browser';
import { App } from './app/app';
import { appConfig } from './app/app.config';

/**
 * Zero Braid code — the whole point.
 *
 * This bundle boots identically whether it is the page (on port 4504) or a fragment inside a realm
 * in the host's page. Nothing here knows which.
 */
bootstrapApplication(App, appConfig).catch((error) => console.error(error));
