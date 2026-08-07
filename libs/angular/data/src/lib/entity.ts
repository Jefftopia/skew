/**
 * Entity identity.
 *
 * The gap this closes: `httpResource()` and friends are *per-call* caches. Two
 * requests that return the same record produce two independent copies, and
 * updating one leaves the other stale. Deduplicating them requires knowing that
 * both payloads describe the same thing — which requires a declared identity.
 */

export interface EntityType<T> {
  /** Stable name, used for store partitioning and tag generation. */
  readonly name: string;
  /** Extracts the primary key. Must be stable and collision-free per type. */
  readonly key: (value: T) => string;
}

export interface EntityDefinition<T> {
  readonly name: string;
  readonly key: (value: T) => string;
}

/**
 * Declares an entity type.
 *
 * ```ts
 * export const Bulletin = entity<Bulletin>({ name: 'bulletin', key: (b) => b.id });
 * ```
 *
 * Declare each type once and export it — identity is only useful if every
 * query and mutation agrees on it.
 */
export function entity<T>(definition: EntityDefinition<T>): EntityType<T> {
  if (!definition.name) {
    throw new TypeError('[skew/data] entity() requires a name');
  }
  if (typeof definition.key !== 'function') {
    throw new TypeError(`[skew/data] entity "${definition.name}" requires a key function`);
  }
  return { name: definition.name, key: definition.key };
}

/** Tag helpers, so invalidation reads the same way everywhere. */
export const tag = {
  /** A single record: `bulletin#42`. */
  entity<T>(type: EntityType<T>, id: string): string {
    return `${type.name}#${id}`;
  },
  /** Every record of a type: `bulletin#*`. */
  all<T>(type: EntityType<T>): string {
    return `${type.name}#*`;
  },
  /** An arbitrary named collection or view. */
  collection(name: string): string {
    return name;
  },
} as const;
