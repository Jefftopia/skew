import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  RegistryConflict,
  registerSchema,
  registryCeiling,
  registryStep,
  resetSchemaRegistry,
  setRegistryConflictHandler,
} from './registry.js';
import { versioned } from './versioned.js';

/**
 * The scenario: a HOST bundle built against v1 and a REMOTE bundle built
 * against v2, loaded into one page, sharing one `@braidlabs/skew` instance. The
 * remote registers its chain; the host — which has never heard of v2 —
 * becomes able to read v2 data anyway.
 */

interface DraftV1 {
  id: string;
  author: string;
}
interface DraftV2 {
  id: string;
  author: { name: string; email: string };
  summary: string;
}

function remoteSchema() {
  return versioned<DraftV1>('shared-draft').next<DraftV2>('structure author; derive summary', {
    up: (v1) => ({ id: v1.id, author: { name: v1.author, email: '' }, summary: '' }),
    down: (v2) => ({ id: v2.id, author: v2.author.name }),
    derives: ['author.email', 'summary'],
    lossy: ['author.email', 'summary'],
  });
}

afterEach(() => {
  resetSchemaRegistry();
  setRegistryConflictHandler(null);
});

describe('schema registry', () => {
  it('is empty until someone registers — sharing is explicit', () => {
    expect(registryStep('shared-draft', 2)).toBeUndefined();
    expect(registryCeiling('shared-draft')).toBeNull();
  });

  it('lets an older bundle read newer data through a step the newer bundle contributed', () => {
    // The remote (newer build) declares and shares its chain...
    const remote = remoteSchema();
    registerSchema(remote);

    // ...writes a v2 record into shared storage...
    const written = remote.write({ id: 'd1', author: { name: 'Rev. Miller', email: 'x@y' }, summary: 'hi' });

    // ...and the HOST — a v1-only build with no local knowledge of v2 —
    // reads an honest projection instead of dead-ending at `ahead`.
    const host = versioned<DraftV1>('shared-draft');
    const result = host.read(written);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ id: 'd1', author: 'Rev. Miller' });
      expect(result.downgradedFrom).toBe(2);
      expect(result.migratedFrom).toBeNull();
      expect(result.lossyPaths).toEqual(['author.email', 'summary']);
    }
  });

  it('without the registration, the same read refuses with ahead — nothing silently changed', () => {
    const written = remoteSchema().write({
      id: 'd1',
      author: { name: 'Rev. Miller', email: 'x@y' },
      summary: 'hi',
    });

    const host = versioned<DraftV1>('shared-draft');
    const result = host.read(written);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('ahead');
  });

  it('cures a gap in an up-chain too, when a bundle registered the missing step', () => {
    registerSchema(remoteSchema());

    // A reader whose local chain was corrupted down to nothing.
    const broken = remoteSchema();
    (broken.steps as unknown as unknown[]).length = 0;

    // Its `version` was computed before the corruption, so reading v1 data
    // still wants the v1 → v2 step — which now only the registry has.
    const result = broken.read({ v: 1, payload: { id: 'd2', author: 'A' } });
    expect(result.ok).toBe(true);
  });

  it('re-registering an identical chain is a no-op, not a conflict', () => {
    const conflicts: RegistryConflict[] = [];
    setRegistryConflictHandler((c) => conflicts.push(c));

    registerSchema(remoteSchema());
    registerSchema(remoteSchema()); // an independent build that agrees

    expect(conflicts).toEqual([]);
  });

  it('reports a conflict when two builds disagree about the same transition, and keeps the first', () => {
    const conflicts: RegistryConflict[] = [];
    setRegistryConflictHandler((c) => conflicts.push(c));

    registerSchema(remoteSchema());

    const disagreeing = versioned<DraftV1>('shared-draft').next<DraftV2>('a DIFFERENT idea of v2', {
      up: (v1) => ({ id: v1.id, author: { name: 'someone else', email: '' }, summary: 'x' }),
      down: (v2) => ({ id: v2.id, author: v2.author.name }),
    });
    registerSchema(disagreeing);

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.name).toBe('shared-draft');
    expect(conflicts[0]?.to).toBe(2);

    // First registration stands: reads still use the original meaning.
    expect(registryStep('shared-draft', 2)?.description).toBe('structure author; derive summary');
  });

  it('reports the ceiling of registered knowledge', () => {
    registerSchema(remoteSchema());
    expect(registryCeiling('shared-draft')).toBe(2);
  });

  it('default conflict handler warns rather than throwing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      registerSchema(remoteSchema());
      registerSchema(
        versioned<DraftV1>('shared-draft').next<DraftV2>('divergent', (v1) => ({
          id: v1.id,
          author: { name: v1.author, email: '' },
          summary: '',
        })),
      );
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
    }
  });
});
