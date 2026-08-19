import { RenderMode, ServerRoute } from '@angular/ssr';

/**
 * Per request, never prerendered — for a sharper reason than the host's.
 *
 * A prerendered panel is a file, and the gateway would happily pierce it; what it would prove is
 * that a static asset can be inlined. "Both sides rendered on the server for *this* request" is the
 * claim POC 2 makes, and only per-request rendering makes it.
 */
export const serverRoutes: ServerRoute[] = [{ path: '**', renderMode: RenderMode.Server }];
