import type { ResolvedFragmentManifest } from './registry.js';
import { BRAID_FRAGMENT_PREFIX } from './protocol.js';

/**
 * Projecting the fragment registry as an FDC3 **App Directory**.
 *
 * The registry already is one. It holds ids, titles, descriptions, tags, and — for fragments that
 * declare them — the intents each app handles and raises. It is already paginated and already
 * filtered by who is asking. AppD is a *shape*, not a second source of truth, so this is a
 * projection over the same data and the same access rules rather than a parallel service to keep
 * in sync.
 *
 * The payoff for FDC3 is direct: `findIntent` becomes a registry query, and because discovery
 * filters by the caller's principal, a user only ever sees resolvers they are permitted to use.
 *
 * **Verify the record shape against the FDC3 AppD v2 spec before relying on it.** The mapping below
 * is faithful to the standard as understood here, but the schema has more optional members than
 * this uses and is the kind of thing that is easy to be subtly wrong about.
 */

/** The `fdc3` block a manifest may carry. A superset of what AppD needs; the rest is for the runtime. */
export interface FragmentFdc3Metadata {
  /** The FDC3 API surface this app speaks, e.g. `"2.2"`. Reserved for the runtime work. */
  apiVersion?: string;
  /** Context schema versions this app reads and writes. Reserved for the runtime work. */
  contexts?: Record<string, number>;
  /** Intents this app handles, and the context types each accepts. */
  listensFor?: Record<string, { contexts?: string[]; displayName?: string; resultType?: string }>;
  /** Intents this app raises, and the context types it raises them with. */
  raises?: Record<string, string[]>;
  /** User channel this app joins on mount. */
  defaultChannel?: string;
  /** Context types broadcast and listened for on user channels. */
  userChannels?: { broadcasts?: string[]; listensFor?: string[] };
}

/** Descriptive fields AppD carries that the registry does not otherwise need. */
export interface FragmentAppdMetadata {
  publisher?: string;
  contactEmail?: string;
  supportEmail?: string;
  moreInfo?: string;
  version?: string;
  tooltip?: string;
  icons?: { src: string; size?: string; type?: string }[];
}

export interface AppdApplication {
  appId: string;
  name: string;
  type: 'web';
  details: { url: string };
  title?: string;
  description?: string;
  tooltip?: string;
  version?: string;
  categories?: string[];
  publisher?: string;
  contactEmail?: string;
  supportEmail?: string;
  moreInfo?: string;
  icons?: { src: string; size?: string; type?: string }[];
  interop?: {
    intents?: {
      listensFor?: Record<string, { name: string; displayName?: string; contexts: string[]; resultType?: string }>;
      raises?: Record<string, string[]>;
    };
    userChannels?: { broadcasts?: string[]; listensFor?: string[] };
  };
  /**
   * Braid-specific launch information.
   *
   * `hostManifests` is exactly what AppD reserves for container-specific detail, and this is the
   * honest place for it: a Braid fragment is **mounted into a page**, not opened as a window. An
   * agent that understands Braid reads this and mounts a `<fragment-slot>`; one that does not
   * falls back to `details.url` and gets something reasonable.
   */
  hostManifests: {
    braid: {
      fragmentId: string;
      /** Where the fragment is addressable — what `<fragment-slot name>` resolves to. */
      mount: string;
      adapter: string;
      /** True when `details.url` is a real page the fragment appears on rather than its mount. */
      standalonePage: boolean;
    };
  };
}

export interface AppdListResponse {
  applications: AppdApplication[];
  message: string;
}

export interface AppdAppResponse {
  application: AppdApplication;
  message: string;
}

/**
 * Projects one manifest into an AppD record.
 *
 * `details.url` is the interesting decision. AppD asks where a web app lives, and a fragment does
 * not live anywhere on its own — it appears inside a host page. So:
 *
 * - if the fragment declares `pierce`, the first pattern names a page it actually appears on, and
 *   that page *is* the answer: an operator following the link sees the app;
 * - otherwise the fragment's mount is used, which is honest but is a namespace path rather than a
 *   page, and `hostManifests.braid.standalonePage` says so.
 *
 * Either way the Braid-aware path is `hostManifests`, because "open this URL" is the wrong verb.
 */
export function toAppdApplication(manifest: ResolvedFragmentManifest, origin: string): AppdApplication {
  const mount = `${BRAID_FRAGMENT_PREFIX}${encodeURIComponent(manifest.id)}/`;
  const page = firstPiercePage(manifest.pierce);

  const application: AppdApplication = {
    appId: manifest.id,
    name: manifest.id,
    type: 'web',
    details: { url: new URL(page ?? mount, origin).href },
    title: manifest.title ?? manifest.id,
    hostManifests: {
      braid: { fragmentId: manifest.id, mount, adapter: manifest.adapter, standalonePage: page !== null },
    },
  };

  if (manifest.description) application.description = manifest.description;
  if (manifest.tags?.length) application.categories = [...manifest.tags];

  const appd = manifest.appd;
  if (appd?.publisher) application.publisher = appd.publisher;
  if (appd?.contactEmail) application.contactEmail = appd.contactEmail;
  if (appd?.supportEmail) application.supportEmail = appd.supportEmail;
  if (appd?.moreInfo) application.moreInfo = appd.moreInfo;
  if (appd?.version) application.version = appd.version;
  if (appd?.tooltip) application.tooltip = appd.tooltip;
  if (appd?.icons?.length) application.icons = appd.icons.map((icon) => ({ ...icon }));

  const interop = toInterop(manifest.fdc3);
  if (interop) application.interop = interop;

  return application;
}

function toInterop(fdc3: FragmentFdc3Metadata | undefined): AppdApplication['interop'] | undefined {
  if (!fdc3) return undefined;

  const listensFor = Object.entries(fdc3.listensFor ?? {}).reduce<
    NonNullable<NonNullable<AppdApplication['interop']>['intents']>['listensFor']
  >((accumulator, [intent, declaration]) => {
    // `name` is required on an AppD intent record and duplicates the key. Filling it from the key
    // rather than requiring it in the manifest keeps one source of truth for the intent's name.
    accumulator![intent] = {
      name: intent,
      contexts: declaration.contexts ?? [],
      ...(declaration.displayName ? { displayName: declaration.displayName } : {}),
      ...(declaration.resultType ? { resultType: declaration.resultType } : {}),
    };
    return accumulator;
  }, {});

  const intents = {
    ...(Object.keys(listensFor ?? {}).length > 0 ? { listensFor } : {}),
    ...(fdc3.raises && Object.keys(fdc3.raises).length > 0 ? { raises: { ...fdc3.raises } } : {}),
  };

  const interop = {
    ...(Object.keys(intents).length > 0 ? { intents } : {}),
    ...(fdc3.userChannels ? { userChannels: { ...fdc3.userChannels } } : {}),
  };

  return Object.keys(interop).length > 0 ? interop : undefined;
}

/**
 * The first pierce pattern reduced to a concrete page path.
 *
 * A wildcard suffix is dropped rather than filled — `/billing/*` becomes `/billing`, which is a
 * page an operator can open. A pattern with a named parameter (`/orders/:id`) names no particular
 * page, so it yields nothing rather than a link to `/orders/undefined`.
 */
function firstPiercePage(pierce: string[] | undefined): string | null {
  for (const pattern of pierce ?? []) {
    if (pattern.includes(':')) continue;
    const trimmed = pattern.replace(/\/?\*+$/, '');
    if (trimmed) return trimmed;
  }
  return null;
}
