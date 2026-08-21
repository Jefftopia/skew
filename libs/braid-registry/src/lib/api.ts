import type { FragmentManifest } from '@braidlabs/gateway';
import { createSnapshot, type RegistrySnapshot } from './snapshot.js';
import type { SnapshotStore } from './store.js';
import { diffRegistries, validateRegistry, type RegistryFinding } from './analysis.js';
import { fetchDescriptors, mergeDescriptors, type DescriptorNote } from './descriptor.js';

/**
 * The registry write API — fetch-native, like the gateway, so it mounts on any runtime.
 *
 * Specified here rather than inside the console for a reason: a team that wants their own UI, or
 * wants to publish from a pipeline, should not have to reverse-engineer an API out of a React app.
 * The console is one client of this, not its owner.
 *
 * **Drafts are not here.** A draft lives in whatever is editing it — the console keeps one in the
 * browser — and only *published* snapshots are server state. That keeps this small and sidesteps
 * multi-editor draft reconciliation entirely; the cost is that drafts do not follow you between
 * devices, which is the right trade until someone actually needs that.
 */
export interface RegistryApiOptions {
  store: SnapshotStore;
  /**
   * Who may read and who may publish — **required for writes**.
   *
   * There is no permissive default. An unauthenticated publish endpoint is remote control of which
   * fragments compose which pages, so omitting this leaves writes refused rather than open. Reads
   * are allowed by default, matching the registry's own public-by-default posture.
   */
  authorize?: (request: Request, action: 'read' | 'publish' | 'pin') => boolean | Promise<boolean>;
  /** Path the API is mounted at. Defaults to `/__braid/registry-api`. */
  basePath?: string;
  /**
   * Whether publishing probes each fragment for a descriptor and merges it (see
   * `descriptor.ts`). Defaults to false: it costs a fanout of requests, and it is only useful once
   * some fragment actually publishes one.
   */
  fetchDescriptors?: boolean;
  fetch?: typeof fetch;
}

export interface PublishRequestBody {
  manifests: FragmentManifest[];
  labels?: Record<string, string>;
  /** Point HEAD at the new snapshot. Defaults to true. */
  pin?: boolean;
}

export interface PublishResult {
  snapshot: { id: string; createdAt: string; fragmentCount: number };
  findings: RegistryFinding[];
  descriptorNotes: DescriptorNote[];
  pinned: boolean;
  /** What this snapshot changes about the one HEAD pointed at before, when there was one. */
  diff?: ReturnType<typeof diffRegistries>;
}

export interface RegistryApi {
  /** Handles a request if it belongs to this API; returns null otherwise. */
  handle(request: Request): Promise<Response | null>;
}

export function createRegistryApi(options: RegistryApiOptions): RegistryApi {
  const { store, authorize, basePath = '/__braid/registry-api', fetchDescriptors: probe = false } = options;

  return {
    async handle(request: Request): Promise<Response | null> {
      const url = new URL(request.url);
      if (!url.pathname.startsWith(basePath)) return null;

      const route = url.pathname.slice(basePath.length) || '/';

      try {
        if (request.method === 'GET' && route === '/snapshots') return await listSnapshots(request, url);
        if (request.method === 'GET' && route.startsWith('/snapshots/')) {
          return await getSnapshot(request, decodeURIComponent(route.slice('/snapshots/'.length)));
        }
        if (request.method === 'GET' && route === '/head') return await getHead(request);
        if (request.method === 'POST' && route === '/snapshots') return await publish(request);
        if (request.method === 'POST' && route === '/head') return await pin(request);

        return json({ error: `no route for ${request.method} ${route}` }, 404);
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : String(error) }, 500);
      }
    },
  };

  async function listSnapshots(request: Request, url: URL): Promise<Response> {
    const denied = await refuse(request, 'read');
    if (denied) return denied;

    const limitParam = Number(url.searchParams.get('limit'));
    const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 100) : 25;

    return json({ items: await store.list({ limit }), head: (await store.head?.()) ?? null });
  }

  async function getSnapshot(request: Request, id: string): Promise<Response> {
    const denied = await refuse(request, 'read');
    if (denied) return denied;

    const snapshot = await store.get(id);
    return snapshot ? json(snapshot) : json({ error: `no snapshot "${id}"` }, 404);
  }

  async function getHead(request: Request): Promise<Response> {
    const denied = await refuse(request, 'read');
    if (denied) return denied;

    const id = (await store.head?.()) ?? null;
    const snapshot = id ? await store.get(id) : null;
    return json({ id, snapshot });
  }

  /**
   * Validates, merges descriptors, mints, stores, and optionally re-pins.
   *
   * Validation runs **here**, on the server, whatever the client already did. The console
   * validates as you type because that is good to use, not because it is trusted; this is the
   * check that decides whether a snapshot exists.
   */
  async function publish(request: Request): Promise<Response> {
    const denied = await refuse(request, 'publish');
    if (denied) return denied;

    const body = (await request.json()) as PublishRequestBody;
    if (!Array.isArray(body?.manifests)) {
      return json({ error: 'expected { manifests: FragmentManifest[] }' }, 400);
    }

    let manifests = body.manifests;
    let descriptorNotes: DescriptorNote[] = [];

    if (probe) {
      const merged = mergeDescriptors(
        manifests,
        await fetchDescriptors(manifests, options.fetch ? { fetch: options.fetch } : {}),
      );
      manifests = merged.manifests;
      descriptorNotes = merged.notes;
    }

    const findings = validateRegistry(manifests);
    if (findings.some((finding) => finding.severity === 'error')) {
      // Nothing is written, so nothing needs undoing — the snapshot model makes refusal cheap.
      return json({ error: 'the registry has errors and was not published', findings, descriptorNotes }, 422);
    }

    const previousId = (await store.head?.()) ?? null;
    const previous = previousId ? await store.get(previousId) : null;

    const snapshot = await createSnapshot({
      manifests,
      ...(body.labels ? { labels: body.labels } : {}),
    });
    await store.put(snapshot);

    const shouldPin = body.pin !== false;
    if (shouldPin) await store.setHead?.(snapshot.id);

    const result: PublishResult = {
      snapshot: { id: snapshot.id, createdAt: snapshot.createdAt, fragmentCount: snapshot.manifests.length },
      findings,
      descriptorNotes,
      pinned: shouldPin,
      ...(previous ? { diff: diffRegistries(previous.manifests, snapshot.manifests) } : {}),
    };

    return json(result, 201);
  }

  async function pin(request: Request): Promise<Response> {
    const denied = await refuse(request, 'pin');
    if (denied) return denied;

    const { id } = (await request.json()) as { id?: string };
    if (!id) return json({ error: 'expected { id }' }, 400);

    const snapshot: RegistrySnapshot | null = await store.get(id);
    if (!snapshot) return json({ error: `no snapshot "${id}" — cannot pin what is not stored` }, 404);

    if (!store.setHead) return json({ error: 'this store does not track a head' }, 501);
    await store.setHead(id);

    return json({ id, pinned: true });
  }

  /** Returns a refusal response, or null when the action is allowed. */
  async function refuse(request: Request, action: 'read' | 'publish' | 'pin'): Promise<Response | null> {
    if (!authorize) {
      if (action === 'read') return null;
      return json(
        {
          error:
            'this registry API has no `authorize` hook, so writes are refused. ' +
            'Publishing changes which fragments compose which pages — wire it to your own session before enabling it.',
        },
        403,
      );
    }

    return (await authorize(request, action)) ? null : json({ error: `not authorized to ${action}` }, 403);
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json;charset=UTF-8', 'cache-control': 'no-store' },
  });
}
