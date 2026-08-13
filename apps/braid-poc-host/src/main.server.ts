import { bootstrapApplication } from '@angular/platform-browser';
import { mergeApplicationConfig } from '@angular/core';
import { provideServerRendering, withRoutes } from '@angular/ssr';
import { App } from './app/app';
import { appConfig } from './app/app.config';
import { serverRoutes } from './app/app.routes.server';

// Angular 22 hands the server bootstrap a context that must be passed through. The type is not
// exported publicly, so derive it from the function signature rather than reaching into internals.
type BootstrapContext = Parameters<typeof bootstrapApplication>[2];

/**
 * The server bootstrap deliberately does *not* initialize Braid: `<fragment-slot>` is a browser
 * custom element, and the fragment's own markup is composed into this app's SSR output by the
 * gateway, not by Angular. On the server the slot renders as an empty element, and the gateway
 * fills it on the way out.
 */
export default (context: BootstrapContext) =>
  bootstrapApplication(
    App,
    mergeApplicationConfig(appConfig, {
      providers: [provideServerRendering(withRoutes(serverRoutes))],
    }),
    context,
  );
