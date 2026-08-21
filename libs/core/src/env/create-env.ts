import { EnvLocation, FragmentEnv } from './fragment-env.js';
import { braidContext } from '../context/context-bus.js';

export interface CreateEnvOptions {
  contentRoot: HTMLElement;
  shadowRoot: ShadowRoot;
  routeUrl: string;
  /** Reads the slot's current props. */
  getProps(): Readonly<Record<string, unknown>>;
  /** Registers a props-change listener; returns an unsubscribe function. */
  onPropsChanged(listener: (props: Readonly<Record<string, unknown>>) => void): () => void;
  /** Fragment → host event dispatch (surfaced as `braid:event` on the slot element). */
  emit(type: string, detail?: unknown): void;
  signal: AbortSignal;
  /** Names this fragment in context-version errors. */
  fragmentId?: string;
  /**
   * The contract version this fragment speaks for each context key, from its manifest.
   *
   * A fragment built months ago reads a context published today, so it declares what it can parse
   * and the bus projects each delivery down to it. Absent, a fragment is assumed current — right for
   * one built from the same source, and the reason a fragment that knows it is behind must say so.
   */
  contextVersions?: Readonly<Record<string, number>>;
}

function parseEnvLocation(routeUrl: string): EnvLocation {
  const url = new URL(routeUrl, document.baseURI);
  return {
    href: url.href,
    pathname: url.pathname,
    search: url.search,
    hash: url.hash,
    basePath: url.pathname,
  };
}

/**
 * Builds the FragmentEnv for a fragment instance.
 *
 * Compat fragments never consume the env — the compat adapter installs the full illusion
 * instead — but the runtime constructs one uniformly so the adapter interface is the same
 * for every adapter, and contract adapters can land later without touching the slot.
 */
export function createFragmentEnv(options: CreateEnvOptions): FragmentEnv {
  const { contentRoot, shadowRoot, routeUrl, signal } = options;

  let location = parseEnvLocation(routeUrl);
  const historyListeners = new Set<(location: EnvLocation) => void>();

  /** The version this fragment declared for a key, and the name to blame if it is unreachable. */
  const contextOptions = (key: string) => ({
    ...(options.contextVersions?.[key] === undefined ? {} : { as: options.contextVersions[key] }),
    ...(options.fragmentId === undefined ? {} : { fragmentId: options.fragmentId }),
  });

  const applyNavigation = (url: string, state: unknown, replace: boolean) => {
    const target = new URL(url, location.href);
    if (replace) {
      window.history.replaceState(state ?? null, '', target.href);
    } else {
      window.history.pushState(state ?? null, '', target.href);
    }
    location = parseEnvLocation(target.href);
    historyListeners.forEach((listener) => listener(location));
  };

  return {
    contractVersion: '1.0',
    root: contentRoot,
    document: {
      get title() {
        return contentRoot.querySelector('title')?.textContent ?? '';
      },
      set title(value: string) {
        const titleElement = contentRoot.querySelector('title');
        if (titleElement) {
          titleElement.textContent = value;
        }
      },
      appendToHead(element: HTMLElement) {
        (contentRoot.querySelector('braid-head') ?? contentRoot).appendChild(element);
      },
      get activeElement() {
        return shadowRoot.activeElement;
      },
      get adoptedStyleSheets() {
        return shadowRoot.adoptedStyleSheets;
      },
    },
    get location() {
      return location;
    },
    history: {
      push: (url, state) => applyNavigation(url, state, false),
      replace: (url, state) => applyNavigation(url, state, true),
      back: () => window.history.back(),
      onChange(listener) {
        historyListeners.add(listener);
        const unsubscribe = () => historyListeners.delete(listener);
        signal.addEventListener('abort', unsubscribe, { once: true });
        return unsubscribe;
      },
    },
    context: {
      get: (key) => braidContext.get(key, contextOptions(key)),
      subscribe: (key, listener, subscribeOptions) =>
        braidContext.subscribe(key, listener, {
          ...contextOptions(key),
          signal: subscribeOptions?.signal ?? signal,
        }),
    },
    get props() {
      return options.getProps();
    },
    onPropsChanged: options.onPropsChanged,
    emit: options.emit,
    signal,
  };
}
