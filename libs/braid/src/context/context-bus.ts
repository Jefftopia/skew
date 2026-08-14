/**
 * Context bus — minimal v0: host-published shared context with subscriptions.
 *
 * Values are structured-cloned at the boundary: shared live objects would create cross-realm
 * retention (GC leaks) and accidental coupling; clone-at-the-boundary keeps fragment instances
 * disposable.
 *
 * Schema-versioned keys and SkewKit contract-migration bridging are not wired up in this
 * compat-only build; when they land, version gaps resolve through registered bidirectional
 * migrations at delivery time, and absent a migration path the mismatch becomes a named
 * `BraidError { stage: 'context-version' }`.
 */

type ContextListener = (value: unknown) => void;

const values = new Map<string, unknown>();
const listeners = new Map<string, Set<ContextListener>>();

export const braidContext = {
  /** Publishes a context value to every fragment (and host code) subscribed to the key. */
  set(key: string, value: unknown): void {
    values.set(key, value);
    listeners.get(key)?.forEach((listener) => listener(structuredClone(value)));
  },

  get(key: string): unknown {
    const value = values.get(key);
    return value === undefined ? undefined : structuredClone(value);
  },

  subscribe(key: string, listener: ContextListener, options?: { signal?: AbortSignal }): () => void {
    let keyListeners = listeners.get(key);
    if (!keyListeners) {
      keyListeners = new Set();
      listeners.set(key, keyListeners);
    }
    keyListeners.add(listener);

    const unsubscribe = () => keyListeners!.delete(listener);
    options?.signal?.addEventListener('abort', unsubscribe, { once: true });
    return unsubscribe;
  },

  /** Exposed for tests. */
  clear(): void {
    values.clear();
    listeners.clear();
  },
};
