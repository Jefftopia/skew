import { RenderMode, ServerRoute } from '@angular/ssr';

/**
 * Every route is rendered per request, never prerendered.
 *
 * Piercing composes the shell and the fragment at request time — a prerendered shell would be
 * a cached artifact with an empty slot, and the fragment would fall back to booting on the
 * client, which is exactly what piercing exists to avoid.
 */
export const serverRoutes: ServerRoute[] = [{ path: '**', renderMode: RenderMode.Server }];
