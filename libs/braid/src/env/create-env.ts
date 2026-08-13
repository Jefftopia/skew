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
 * Builds the FragmentEnv (C3) for a fragment instance.
 *
 * Compat fragments never consume the env — the compat adapter installs the full illusion
 * instead — but the runtime constructs one uniformly so the adapter interface (C4) is the same
 * for every adapter, and contract adapters can land later without touching the slot.
 */
export function createFragmentEnv(options: CreateEnvOptions): FragmentEnv {
  const { contentRoot, shadowRoot, routeUrl, signal } = options;

  let location = parseEnvLocation(routeUrl);
  const historyListeners = new Set<(location: EnvLocation) => void>();

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
      get: (key) => braidContext.get(key),
      subscribe: (key, listener, subscribeOptions) =>
        braidContext.subscribe(key, listener, {
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
