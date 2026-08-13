/**
 * `FragmentEnv` (C3) — the contract object graph a fragment sees instead of patched globals.
 *
 * Contract-mode fragments receive this env through their adapter's `mount(env, entry)` call and
 * never touch realm globals. Compat-mode fragments (the only adapter shipped in this build) do
 * not consume the env — the compat adapter installs the full document/window illusion instead —
 * but the contract is defined here because it is the heart of the project and the adapter
 * interface is written against it.
 *
 * Design rules: every member is a real object with a stable identity (no getters that change
 * shape), every mutation path is explicit, and nothing on `FragmentEnv` requires the realm.
 */

export interface EnvDocument {
  /** Sets or reads the fragment's logical document title. Bound fragments propagate it to the host. */
  title: string;
  /** Appends a stylesheet or other head-scoped element to the fragment's head region. */
  appendToHead(element: HTMLElement): void;
  readonly activeElement: Element | null;
  readonly adoptedStyleSheets: CSSStyleSheet[];
}

export interface EnvLocation {
  readonly href: string;
  readonly pathname: string;
  readonly search: string;
  readonly hash: string;
  /** The base path the fragment is mounted under; adapters feed this into router configuration. */
  readonly basePath: string;
}

export interface EnvHistory {
  push(url: string, state?: unknown): void;
  replace(url: string, state?: unknown): void;
  back(): void;
  /** Subscribes to location changes; automatically unsubscribed when `env.signal` aborts. */
  onChange(listener: (location: EnvLocation) => void): () => void;
}

export interface EnvContext {
  get(key: string): unknown;
  subscribe(key: string, listener: (value: unknown) => void, options?: { signal?: AbortSignal }): () => void;
}

export interface FragmentEnv {
  readonly contractVersion: '1.0';
  /** Mount point inside the fragment's shadow root. */
  readonly root: HTMLElement;
  readonly document: EnvDocument;
  readonly location: EnvLocation;
  readonly history: EnvHistory;
  readonly context: EnvContext;
  readonly props: Readonly<Record<string, unknown>>;
  onPropsChanged(listener: (props: Readonly<Record<string, unknown>>) => void): () => void;
  /** Fragment → host event channel, surfaced as `braid:event` on the slot element. */
  emit(type: string, detail?: unknown): void;
  /** Fires on unmount — wire everything to it. */
  readonly signal: AbortSignal;
}
