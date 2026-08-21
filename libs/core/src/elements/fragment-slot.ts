import { BraidError } from '../errors.js';
import { braidDocumentUrl, BRAID_FRAGMENT_ID_HEADER } from '../protocol.js';
import { createRealm } from '../realm/realm-manager.js';
import { resolveAdapter } from '../adapters/adapter.js';
import { createFragmentEnv } from '../env/create-env.js';
import { isDevMode } from '../config.js';

export type FragmentSlotState = 'idle' | 'loading' | 'ready' | 'error';

/**
 * Finds server-rendered fragment content the gateway pierced into a slot.
 *
 * Deliberately a direct-children scan rather than `querySelector(':scope > braid-document')`:
 * `:scope` has no element to match against on a ShadowRoot, so that selector silently never
 * matches. The failure mode is invisible from inside the page — the slot just quietly re-fetches
 * and replaces identical content — so it is worth a named helper and a test.
 */
export function findPiercedContentRoot(shadowRoot: ShadowRoot | null): HTMLElement | null {
  if (!shadowRoot) return null;
  for (const child of shadowRoot.children) {
    if (child.tagName === 'BRAID-DOCUMENT') return child as HTMLElement;
  }
  return null;
}

/**
 * `<fragment-slot>` — the custom element a host renders to mount a fragment.
 *
 * ```html
 * <fragment-slot name="checkout"></fragment-slot>
 * ```
 *
 * - `name` — the fragment id in the gateway registry (required).
 * - `src` — optional route url for the fragment. When absent, the fragment is *bound*: it
 *   follows the host page's location and participates in host navigation.
 * - `props` — JSON attribute (or the `props` property) passed to the fragment instance.
 *
 * Events: `braid:ready`, `braid:error` (detail includes stage + fix hint), `braid:event`
 * (fragment → host).
 *
 * The slot uses only its own shadow root and its own elements — the host page is never patched.
 */
export class FragmentSlot extends HTMLElement {
  static get observedAttributes() {
    return ['name', 'src', 'props'];
  }

  #state: FragmentSlotState = 'idle';
  #props: Record<string, unknown> = {};
  #propsListeners = new Set<(props: Readonly<Record<string, unknown>>) => void>();
  #abortController: AbortController | undefined;
  #booted = false;
  #bootScheduled = false;
  /** Set by reload(): a reload must re-fetch, never re-adopt the pierced content. */
  #forceFetch = false;

  get state(): FragmentSlotState {
    return this.#state;
  }

  get name(): string {
    return this.getAttribute('name') ?? '';
  }

  get props(): Record<string, unknown> {
    return this.#props;
  }

  set props(value: Record<string, unknown>) {
    this.#props = structuredClone(value ?? {});
    this.#propsListeners.forEach((listener) => listener(this.#props));
  }

  attributeChangedCallback(attribute: string, oldValue: string | null, newValue: string | null) {
    if (attribute === 'props') {
      try {
        this.props = newValue ? JSON.parse(newValue) : {};
      } catch (error) {
        console.warn(`[braid:${this.name}] ignoring unparsable props attribute`, error);
      }
    } else if (attribute === 'name' && oldValue !== newValue) {
      if (this.isConnected && this.#booted) {
        void this.reload();
      } else if (this.isConnected && !this.#booted && !this.#bootScheduled) {
        this.#bootScheduled = true;
        queueMicrotask(() => {
          this.#bootScheduled = false;
          if (this.isConnected && !this.#booted) {
            this.#booted = true;
            void this.#boot();
          }
        });
      }
    }
  }

  connectedCallback() {
    if (this.#booted || this.#bootScheduled) {
      return;
    }
    this.#bootScheduled = true;
    queueMicrotask(() => {
      this.#bootScheduled = false;
      if (!this.isConnected || this.#booted) {
        return;
      }
      this.#booted = true;
      void this.#boot();
    });
  }

  disconnectedCallback() {
    this.#bootScheduled = false;
    this.#teardown();
    this.#booted = false;
  }

  async reload(): Promise<void> {
    this.#teardown();
    this.#forceFetch = true;
    await this.#boot();
  }

  #teardown() {
    this.#abortController?.abort();
    this.#abortController = undefined;
    this.shadowRoot?.replaceChildren();
    this.#state = 'idle';
  }

  async #boot(): Promise<void> {
    const fragmentId = this.name;

    try {
      if (!fragmentId) {
        throw new BraidError('the <fragment-slot> element is missing its name attribute', {
          fragmentId: '<unnamed>',
          stage: 'slot-config',
          fixHint: '<fragment-slot name="..."> must name a fragment registered in the gateway',
        });
      }

      if (this.getAttribute('trust') === 'untrusted') {
        throw new BraidError('the untrusted tier is not available in this build', {
          fragmentId,
          stage: 'slot-config',
          fixHint: 'this build of @braid/core ships the trusted compat tier only',
        });
      }

      this.#state = 'loading';

      const abortController = new AbortController();
      this.#abortController = abortController;
      const signal = abortController.signal;

      // src present → standalone fragment pinned to that route; absent → bound to host location
      const src = this.getAttribute('src');
      const bound = !src;
      const routeUrl = src ?? location.pathname + location.search;
      const routeSrcUrl = new URL(routeUrl, document.baseURI);

      /**
       * Pierced fragments arrive with their content already in the DOM: the gateway wrote a
       * declarative shadow root into this element, and the browser parsed it at the same time
       * as the rest of the page. Adopting it is strictly better than fetching — the
       * content is already painted, and re-fetching it would replace live DOM with identical
       * DOM. `#forceFetch` is set by reload(), which must go back to the network.
       */
      const piercedContentRoot = this.#forceFetch ? null : findPiercedContentRoot(this.shadowRoot);

      let shadowRoot: ShadowRoot;
      let contentRoot: HTMLElement;

      if (piercedContentRoot) {
        shadowRoot = this.shadowRoot!;
        contentRoot = piercedContentRoot;
      } else {
        shadowRoot = this.shadowRoot ?? this.attachShadow({ mode: 'open' });
        const styleSheet = document.createElement('style');
        styleSheet.textContent =
          ':host, braid-document, braid-html, braid-body { display: block; } braid-head { display: none; }';
        contentRoot = document.createElement('braid-document');
        shadowRoot.replaceChildren(styleSheet, contentRoot);
      }

      /**
       * Boot the realm and fetch the fragment's document at the same time, unless it was
       * already pierced in. Both go through the gateway's namespaces, addressed by id.
       *
       * Which adapter a fragment uses is only known once the realm stub has loaded, so the
       * document request is started optimistically and its failure is held rather than thrown:
       * an adapter that builds its own UI from an entry module (a lone custom element, say) has
       * no document to fetch, and must not be reported as broken for not serving one.
       */
      const [htmlResult, realm] = await Promise.all([
        piercedContentRoot
          ? Promise.resolve({ ok: true as const, html: null })
          : this.#fetchFragmentHtml(fragmentId, routeSrcUrl, signal).then(
              (html) => ({ ok: true as const, html }),
              (error: unknown) => ({ ok: false as const, error }),
            ),
        createRealm('compat-http', { fragmentId, routeUrl, bound, signal }),
      ]);

      // The gateway stamps the manifest-declared adapter onto the realm stub; unknown adapters
      // fail as a named error, and an undeclared adapter resolves to the default (compat).
      const adapter = resolveAdapter(realm.manifestAdapter, fragmentId);

      if (!htmlResult.ok && adapter.needsDocument !== false) throw htmlResult.error;
      const html = htmlResult.ok ? htmlResult.html : null;

      const env = createFragmentEnv({
        contentRoot,
        shadowRoot,
        routeUrl,
        getProps: () => this.#props,
        onPropsChanged: (listener) => {
          this.#propsListeners.add(listener);
          const unsubscribe = () => this.#propsListeners.delete(listener);
          signal.addEventListener('abort', unsubscribe, { once: true });
          return unsubscribe;
        },
        emit: (type, detail) => {
          this.dispatchEvent(new CustomEvent('braid:event', { detail: { type, detail }, bubbles: true }));
        },
        signal,
      });

      await adapter.boot({
        fragmentId,
        shadowRoot,
        contentRoot,
        realm,
        html,
        pierced: Boolean(piercedContentRoot),
        routeUrl,
        bound,
        env,
        signal,
      });

      if (signal.aborted) return;

      this.#state = 'ready';
      this.dispatchEvent(new CustomEvent('braid:ready', { detail: { fragmentId } }));
      if (isDevMode()) {
        console.debug(`[braid:${fragmentId}] ready`, { slot: this });
      }
    } catch (error) {
      if (this.#abortController?.signal.aborted) return;

      this.#state = 'error';
      const braidError =
        error instanceof BraidError
          ? error
          : new BraidError(error instanceof Error ? error.message : String(error), {
              fragmentId,
              stage: 'adapter-mount',
              cause: error,
            });

      console.error(braidError);
      this.dispatchEvent(
        new CustomEvent('braid:error', {
          detail: {
            fragmentId: braidError.fragmentId,
            stage: braidError.stage,
            fixHint: braidError.fixHint,
            error: braidError,
          },
        }),
      );
    }
  }

  async #fetchFragmentHtml(fragmentId: string, routeSrcUrl: URL, signal: AbortSignal): Promise<string> {
    // the document namespace: the gateway prepares this exactly as it prepares pierced content
    const documentUrl = braidDocumentUrl(fragmentId, routeSrcUrl.pathname, routeSrcUrl.search);

    let response: Response;
    try {
      response = await fetch(documentUrl, {
        headers: {
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          [BRAID_FRAGMENT_ID_HEADER]: fragmentId,
        },
        signal,
      });
    } catch (error) {
      throw new BraidError(`fetching the fragment's html from "${documentUrl}" failed`, {
        fragmentId,
        stage: 'fragment-fetch',
        cause: error,
        fixHint: 'ensure the braid gateway is mounted in front of this app and reachable from the browser',
      });
    }

    if (!response.ok) {
      throw new BraidError(
        `the gateway responded with HTTP ${response.status} for "${documentUrl}"`,
        {
          fragmentId,
          stage: 'fragment-fetch',
          fixHint:
            response.status === 404
              ? `register a manifest for fragment id "${fragmentId}" in the gateway registry`
              : `check the gateway logs for fragment id "${fragmentId}"`,
        },
      );
    }

    return response.text();
  }
}
