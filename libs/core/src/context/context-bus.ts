import type { VersionedSchema } from '@braidlabs/skew';
import { BraidError } from '../errors.js';

/**
 * Context bus — host-published shared state, delivered at each subscriber's own contract version.
 *
 * Values are structured-cloned at the boundary: sharing live objects across realms creates
 * cross-realm retention (GC leaks) and accidental coupling, and clone-at-the-boundary keeps fragment
 * instances disposable.
 *
 * **Versioning is what makes this a bus rather than an event emitter.** A page composes fragments
 * built at different times, so the publisher and a subscriber routinely disagree about what a
 * context payload looks like. Register a `@braidlabs/skew` schema for a key and every delivery is
 * projected to the version that subscriber asked for — older subscribers get the older shape, and
 * neither side has to know the other exists.
 *
 * Two decisions worth stating, because both were tempting to get wrong:
 *
 * 1. **Reachability is checked when a fragment subscribes, not when a value is broadcast.**
 *    Projecting down needs a `down` on every intervening step, and a chain missing one is a
 *    programming error in your own contract rather than data skew. Discovering it mid-broadcast
 *    would fail one delivery deep inside a fan-out with the other subscribers already served;
 *    refusing the subscription makes it a start-up error with a fragment's name on it.
 * 2. **An unregistered key passes through untouched.** A bus that demanded a schema for every value
 *    is a bus nobody adopts incrementally. Untyped contexts are cloned and delivered as they are,
 *    exactly as the v0 bus did.
 */

type ContextListener = (value: unknown) => void;

export interface ContextSubscribeOptions {
  signal?: AbortSignal;
  /**
   * The contract version this subscriber speaks. Defaults to the registered schema's current
   * version — right for a fragment built from the same source, wrong for every fragment that was
   * not, so a fragment that knows it is behind should say so.
   */
  as?: number;
  /** Names the fragment in any error raised. Falls back to the context key. */
  fragmentId?: string;
}

export interface ContextReadOptions {
  as?: number;
  fragmentId?: string;
}

interface Subscription {
  listener: ContextListener;
  as?: number;
}

const values = new Map<string, unknown>();
const subscriptions = new Map<string, Set<Subscription>>();
const schemas = new Map<string, VersionedSchema<unknown>>();

export const braidContext = {
  /**
   * Declares the contract a context key carries.
   *
   * Registering after values have been published is allowed, and deliberately so: the host learns a
   * fragment's contract when that fragment mounts, which is later than the first broadcast on every
   * real page.
   */
  register<T>(key: string, schema: VersionedSchema<T>): void {
    schemas.set(key, schema as VersionedSchema<unknown>);
  },

  /** The schema registered for a key, if any. */
  schemaFor(key: string): VersionedSchema<unknown> | undefined {
    return schemas.get(key);
  },

  /**
   * Publishes a context value to every fragment (and host code) subscribed to the key.
   *
   * **Every subscriber is isolated.** One fragment throwing in its listener — or declaring a version
   * that became unreachable after it subscribed — must not stop delivery to the fragments after it
   * in the set. Without that, a bad deploy of one app presents as a *different* app silently
   * failing to update, which is the least debuggable shape a bug can take on a composed page.
   */
  set(key: string, value: unknown): void {
    values.set(key, value);

    for (const subscription of [...(subscriptions.get(key) ?? [])]) {
      try {
        subscription.listener(project(key, value, subscription.as));
      } catch (error) {
        // Reported rather than swallowed: a subscriber that never hears anything again is worth
        // knowing about, and this is the only place that can see it happen.
        console.error(`braid: a "${key}" context subscriber threw; other subscribers were unaffected`, error);
      }
    }
  },

  get(key: string, options?: ContextReadOptions): unknown {
    const value = values.get(key);
    if (value === undefined) return undefined;

    // A read at an unreachable version is the same error as a subscription at one, and is raised
    // rather than quietly answered at the publisher's version: handing a fragment a shape it cannot
    // parse is how a context bus produces a stack trace in someone else's code.
    assertReachable(key, options?.as, options?.fragmentId);
    return project(key, value, options?.as);
  },

  subscribe(key: string, listener: ContextListener, options?: ContextSubscribeOptions): () => void {
    assertReachable(key, options?.as, options?.fragmentId);

    let keySubscriptions = subscriptions.get(key);
    if (!keySubscriptions) {
      keySubscriptions = new Set();
      subscriptions.set(key, keySubscriptions);
    }
    const subscription: Subscription = {
      listener,
      ...(options?.as === undefined ? {} : { as: options.as }),
    };
    keySubscriptions.add(subscription);

    const unsubscribe = () => void keySubscriptions.delete(subscription);
    options?.signal?.addEventListener('abort', unsubscribe, { once: true });
    return unsubscribe;
  },

  /** Exposed for tests. */
  clear(): void {
    values.clear();
    subscriptions.clear();
    schemas.clear();
  },
};

/**
 * Projects a published value to one subscriber's version.
 *
 * `write({ as })` down-migrates and returns the older envelope — the polite move when the reader is
 * known to be older than the publisher. Subscribers receive the payload rather than the envelope:
 * the version they asked for is the version they get, so handing them a wrapper to unwrap would be
 * ceremony without information.
 */
function project(key: string, value: unknown, as: number | undefined): unknown {
  const schema = schemas.get(key);
  if (!schema) return structuredClone(value);

  const envelope = as === undefined || as === schema.version ? schema.write(value) : schema.write(value, { as });
  return structuredClone(envelope.payload);
}

/**
 * Refuses a subscriber whose version cannot be reached from the publisher's.
 *
 * Decided from the declared chain rather than by attempting a migration, so the answer does not
 * depend on a value happening to have been published yet — a fragment that mounts before the first
 * broadcast deserves the same error as one that mounts after it.
 */
function assertReachable(key: string, as: number | undefined, fragmentId: string | undefined): void {
  const schema = schemas.get(key);
  if (!schema || as === undefined || as === schema.version) return;

  const raise = (message: string, fixHint: string): never => {
    throw new BraidError(message, { fragmentId: fragmentId ?? key, stage: 'context-version', fixHint });
  };

  if (as > schema.version) {
    raise(
      `context "${key}" is published at v${schema.version}, and this subscriber asked for v${as}`,
      'the publisher is older than the subscriber — deploy the host, or subscribe at a version it can produce',
    );
  }

  if (as < 1) raise(`context "${key}" has no v${as}`, 'contract versions start at 1');

  // Every step between the subscriber's version and the publisher's has to walk back down.
  const missing = schema.steps
    .filter((step) => step.to > as && step.to <= schema.version && !step.down)
    .map((step) => `v${step.to} (${step.description})`);

  if (missing.length > 0) {
    raise(
      `context "${key}" cannot be projected from v${schema.version} down to v${as}: ` +
        `${missing.join(', ')} ${missing.length === 1 ? 'declares' : 'declare'} no down migration`,
      `add a down migration to the step that introduced ${missing[0]}, or subscribe at v${schema.version}`,
    );
  }
}
