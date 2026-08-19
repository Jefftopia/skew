import { bootstrapApplication } from '@angular/platform-browser';
import { mergeApplicationConfig } from '@angular/core';
import { provideServerRendering, withRoutes } from '@angular/ssr';
import { App } from './app/app';
import { appConfig } from './app/app.config';
import { serverRoutes } from './app/app.routes.server';

// The Angular 22 server bootstrap takes a context that must be passed through; its type is not
// exported, so it is derived from the signature rather than reached for in internals.
type BootstrapContext = Parameters<typeof bootstrapApplication>[2];

export default (context: BootstrapContext) =>
  bootstrapApplication(
    App,
    mergeApplicationConfig(appConfig, { providers: [provideServerRendering(withRoutes(serverRoutes))] }),
    context,
  );
