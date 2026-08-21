/**
 * Node bindings for `@braid/registry`.
 *
 * Separate from the main entry so the core stays platform-neutral — a browser bundling the
 * console must not drag `node:fs` in behind it.
 */

export { fileSnapshotStore } from './lib/file-store.js';
export type { FileSnapshotStoreOptions } from './lib/file-store.js';
