/**
 * @skewkit/braid-registry — immutable snapshots of a Braid fragment registry, and analysis over
 * them.
 *
 * ```ts
 * import { createSnapshot, memorySnapshotStore, snapshotRegistry } from '@skewkit/braid-registry';
 *
 * const snapshot = await createSnapshot({ manifests });
 * await store.put(snapshot);
 *
 * createGateway({ registry: snapshotRegistry({ store, pinned: snapshot.id }) });
 * ```
 *
 * Everything exported here is platform-neutral — it runs on Node, Workers, Deno, Bun, and in a
 * browser. The filesystem store lives at `@skewkit/braid-registry/node`.
 */

export { createSnapshot, verifySnapshot, serializeSnapshot, parseSnapshot, SNAPSHOT_ID_PREFIX } from './lib/snapshot.js';
export type { RegistrySnapshot, SnapshotInput } from './lib/snapshot.js';

export { memorySnapshotStore, toRef } from './lib/store.js';
export type { SnapshotStore, SnapshotRef } from './lib/store.js';

export { snapshotRegistry } from './lib/source.js';
export type { SnapshotRegistryOptions, SnapshotDiagnostic } from './lib/source.js';

export { validateRegistry, findPierceOverlaps, diffRegistries, fieldOwner } from './lib/analysis.js';

export { fetchDescriptors, mergeDescriptors, DEFAULT_DESCRIPTOR_PATH } from './lib/descriptor.js';
export type {
  FragmentDescriptor,
  DescriptorNote,
  DescriptorNoteKind,
  DescriptorMergeResult,
  FetchDescriptorsOptions,
} from './lib/descriptor.js';

export { createRegistryApi } from './lib/api.js';
export type { RegistryApi, RegistryApiOptions, PublishRequestBody, PublishResult } from './lib/api.js';
export type {
  RegistryFinding,
  FindingCode,
  FindingSeverity,
  RegistryDiff,
  FieldChange,
  FieldOwner,
} from './lib/analysis.js';
