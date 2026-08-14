import { BRAID_FRAGMENT_PREFIX } from '../protocol.js';
import { concatStreams, Injection, rewriteHtmlStream, StartTag } from './html-rewrite-stream.js';

/**
 * The composition protocol's HTML transforms, expressed against the owned rewriter.
 *
 * These are the normative behaviors a Braid gateway must implement; the conformance vectors in
 * `transforms.spec.ts` are their oracle, and any second implementation (a native `HTMLRewriter`
 * path on workerd, say) must pass the same vectors before it is allowed to serve traffic.
 */

/** The `<style>` the shell needs for slots and fragment stand-ins to lay out as blocks. */
export const BRAID_SHELL_STYLES =
  '<style>fragment-slot { display: block; }</style>';

/** The `<style>` that goes inside every fragment's shadow root. */
export const BRAID_FRAGMENT_STYLES =
  '<style>:host, braid-document, braid-html, braid-body { display: block; } braid-head { display: none; }</style>';

/**
 * Inline event handler content attributes (`onclick`, `onerror`, …).
 *
 * Deliberately `on` + letters only: the browser compiles these into functions **in the document
 * that owns the node**, which for fragment content is the host page — so they are a wrong-realm
 * execution path. Framework binding syntaxes that merely look similar (`on-click`, `x-on:click`,
 * `@click`, `(click)`) contain a non-letter and are left alone; they are interpreted by the
 * fragment's own framework inside the fragment's realm, so removing them would break the app
 * without buying any isolation.
 */
const INLINE_EVENT_HANDLER = /^on[a-z]+$/;

/**
 * Attributes that point at a **subresource** the fragment owns, per element.
 *
 * A fragment's markup ends up in the host page's DOM, so these URLs resolve against the *host*
 * page rather than the fragment — `styles.css` on a host page at `/billing/invoices` would be
 * fetched from `/billing/styles.css`, which belongs to the host. Rewriting them into the
 * fragment's namespace is what makes "the fragment is served through the gateway" true for
 * everything its markup references, not just the code the realm executes.
 *
 * Navigation targets (`a[href]`, `form[action]`, `area[href]`) are deliberately absent: those
 * are page navigations, and in bound mode they belong to the host's URL space. `base[href]` is
 * absent too — it is what the fragment's own router reads to know its base path, and rewriting
 * it into the namespace would break routing.
 */
const SUBRESOURCE_ATTRIBUTES: Record<string, readonly string[]> = {
  audio: ['src'],
  embed: ['src'],
  iframe: ['src'],
  img: ['src', 'srcset'],
  input: ['src'],
  link: ['href'],
  object: ['data'],
  script: ['src'],
  source: ['src', 'srcset'],
  track: ['src'],
  use: ['href'],
  video: ['src', 'poster'],
};

const SRCSET_ATTRIBUTES = new Set(['srcset']);

/**
 * Prepares a fragment's HTML for life inside the host page:
 *
 * - the doctype is stripped (a nested doctype makes some parsers choke, and it materializes
 *   nothing in the DOM anyway);
 * - `<html>`/`<head>`/`<body>` become `braid-html`/`braid-head`/`braid-body`, because the DOM
 *   forbids duplicates of those singletons and would silently drop them;
 * - every `<script>` is neutralized (`type="inert"`, real type parked in `data-script-type`) so
 *   it cannot execute in the host's JS context — the client activates it in the fragment's realm;
 * - script preload/prefetch/modulepreload links become `rel="inert-*"` so they don't trigger a
 *   duplicate load in the host context;
 * - inline event handler attributes are removed, and `<meta http-equiv="refresh">` is defanged.
 *
 * This is the server half of the born-inert invariant, and the last two rules are what make the
 * invariant true rather than merely true-of-`<script>`: **no markup a fragment sends can execute
 * JavaScript in the host realm or navigate the host page.** Both were verified executing in the
 * host realm before this transform existed.
 *
 * Still not neutralized, because they require user interaction rather than executing on parse:
 * `javascript:` URLs and form `action`s. Those remain within the trusted tier's stated model —
 * a trusted fragment can navigate the page a user clicks through — and are called out in the
 * security section of the README.
 */
export function prepareFragmentHtml(
  body: ReadableStream<Uint8Array>,
  options: { fragmentId: string },
): ReadableStream<Uint8Array> {
  const { fragmentId } = options;

  // The fragment's own <base href>, which its subresource URLs resolve against. It appears in
  // <head> before anything that references it, so tracking it as the stream passes is enough.
  let fragmentBaseHref = '/';

  return rewriteHtmlStream(body, {
    stripDoctype: true,
    handlers: {
      '*': {
        element(tag) {
          for (const attributeName of tag.attributeNames) {
            if (INLINE_EVENT_HANDLER.test(attributeName)) {
              tag.removeAttribute(attributeName);
            }
          }
          rewriteSubresourceUrls(tag, fragmentId, fragmentBaseHref);
        },
      },
      base: {
        element(tag) {
          // read, never rewrite: this is what the fragment's router reads as its base path
          const href = tag.getAttribute('href');
          if (href) fragmentBaseHref = href;
        },
      },
      html: { element: (tag) => void (tag.tagName = 'braid-html') },
      head: { element: (tag) => void (tag.tagName = 'braid-head') },
      body: { element: (tag) => void (tag.tagName = 'braid-body') },
      script: {
        element(tag) {
          const type = tag.getAttribute('type');
          if (type) tag.setAttribute('data-script-type', type);
          tag.setAttribute('type', 'inert');
        },
      },
      link: {
        element(tag) {
          const rel = tag.getAttribute('rel');
          if (rel === 'preload' || rel === 'prefetch' || rel === 'modulepreload') {
            tag.setAttribute('rel', `inert-${rel}`);
          }
        },
      },
      meta: {
        element(tag) {
          // a meta refresh anywhere in the page navigates the whole host document, throwing away
          // the shell and every other fragment on it
          if (tag.getAttribute('http-equiv')?.trim().toLowerCase() !== 'refresh') return;
          tag.removeAttribute('http-equiv');
          tag.setAttribute('data-braid-blocked', 'meta-refresh');
        },
      },
    },
  });
}

/** Rewrites a tag's subresource URLs into the fragment's namespace. */
function rewriteSubresourceUrls(tag: StartTag, fragmentId: string, baseHref: string): void {
  const attributes = SUBRESOURCE_ATTRIBUTES[tag.tagName];
  if (!attributes) return;

  for (const attributeName of attributes) {
    const value = tag.getAttribute(attributeName);
    if (!value) continue;

    const rewritten = SRCSET_ATTRIBUTES.has(attributeName)
      ? rewriteSrcset(value, fragmentId, baseHref)
      : namespaceUrl(value, fragmentId, baseHref);

    if (rewritten !== null) {
      tag.setAttribute(attributeName, rewritten);
    }
  }
}

/**
 * Maps one URL into the fragment's namespace, or returns null to leave it untouched.
 *
 * Left alone: anything with a scheme (`https:`, `data:`, `blob:`), protocol-relative URLs, and
 * pure fragment identifiers — none of those are the fragment's own subresources.
 */
function namespaceUrl(rawUrl: string, fragmentId: string, baseHref: string): string | null {
  const url = rawUrl.trim();
  if (!url || url.startsWith('#') || url.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(url)) {
    return null;
  }

  // resolve exactly as the browser would have in the fragment's own document, then re-root it
  const resolved = new URL(url, `http://braid.invalid${baseHref.startsWith('/') ? baseHref : `/${baseHref}`}`);
  return `${BRAID_FRAGMENT_PREFIX}${encodeURIComponent(fragmentId)}${resolved.pathname}${resolved.search}${resolved.hash}`;
}

/** Rewrites each candidate in a `srcset`, preserving its density/width descriptors. */
function rewriteSrcset(value: string, fragmentId: string, baseHref: string): string | null {
  const candidates = value.split(',');
  let changed = false;

  const rewritten = candidates.map((candidate) => {
    const match = /^(\s*)(\S+)(\s*.*)$/.exec(candidate);
    if (!match) return candidate;

    const [, leading, url, descriptor] = match;
    const namespaced = namespaceUrl(url, fragmentId, baseHref);
    if (namespaced === null) return candidate;

    changed = true;
    return `${leading}${namespaced}${descriptor}`;
  });

  return changed ? rewritten.join(',') : null;
}

export interface PierceTarget {
  fragmentId: string;
  /**
   * The fragment's prepared content (see {@link prepareFragmentHtml}), or null to pierce
   * nothing — the slot is left for the client to fill by fetching (the `omit`/`placeholder`
   * failure fallbacks).
   */
  content: ReadableStream<Uint8Array> | null;
  /** Set as `data-braid-fallback` on the slot when content is omitted, for skeleton styling. */
  fallbackReason?: string;
}

export interface PierceOptions {
  /** The shell application's HTML. */
  shell: ReadableStream<Uint8Array>;
  /** The fragments to pierce into this document, in registration order. */
  fragments: PierceTarget[];
}

/**
 * Pierces a fragment into the shell's HTML stream.
 *
 * The fragment's server-rendered content is injected into the matching `<fragment-slot>` as a
 * declarative shadow root, so the browser parses it into exactly the shape the client runtime
 * would have built — the slot then adopts it instead of fetching, and the fragment paints as
 * part of the shell's first response rather than a round trip later.
 *
 * Injection is stream-interleaved: the shell streams out until the slot is reached, the
 * fragment's stream is spliced in as it arrives, then the rest of the shell follows.
 *
 * If the shell contains no matching slot, the fragment is appended before `</body>` (or at the
 * end of the document — `</body>` is optional in HTML and often omitted) inside a slot element
 * the gateway creates. This keeps piercing working for shells that haven't been marked up yet.
 */
export function pierceShellHtml(options: PierceOptions): ReadableStream<Uint8Array> {
  const { shell } = options;

  const pending = new Map(options.fragments.map((fragment) => [fragment.fragmentId, fragment]));
  let stylesInjected = false;

  const shadowRoot = (target: PierceTarget): Injection[] => [
    '<template shadowrootmode="open">',
    BRAID_FRAGMENT_STYLES,
    '<braid-document>',
    target.content ?? '',
    '</braid-document></template>',
  ];

  /** A slot element the gateway creates because the shell didn't mark one up. */
  const orphanSlot = (target: PierceTarget): Injection =>
    concatStreams([
      `<fragment-slot name="${escapeAttribute(target.fragmentId)}" data-braid-pierced="">`,
      ...shadowRoot(target),
      '</fragment-slot>',
    ]);

  /** Every fragment that never found a slot, appended in registration order. */
  const remainingOrphans = (): Injection | undefined => {
    const orphans = [...pending.values()].filter((target) => target.content);
    pending.clear();
    return orphans.length ? concatStreams(orphans.map(orphanSlot)) : undefined;
  };

  return rewriteHtmlStream(shell, {
    handlers: {
      head: {
        element(tag) {
          if (stylesInjected) return;
          stylesInjected = true;
          tag.prepend(BRAID_SHELL_STYLES);
        },
      },

      'fragment-slot': {
        element(tag) {
          const name = tag.getAttribute('name');
          const target = name ? pending.get(name) : undefined;
          if (!target) return;
          pending.delete(target.fragmentId);

          if (!target.content) {
            // nothing to pierce: mark the slot so the page can style a skeleton, and let the
            // client runtime fetch the fragment itself
            if (target.fallbackReason) tag.setAttribute('data-braid-fallback', target.fallbackReason);
            return;
          }

          tag.setAttribute('data-braid-pierced', '');
          for (const part of shadowRoot(target)) {
            tag.prepend(part);
          }
        },
      },

      body: {
        endTag(tag) {
          const orphans = remainingOrphans();
          if (orphans) tag.before(orphans);
        },
      },
    },

    // `</body>` is optional in HTML and frequently omitted — this is the safety net
    onEnd: remainingOrphans,
  });
}

function escapeAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
}
