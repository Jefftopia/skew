import { afterEach, describe, expect, it, vi } from 'vitest';
import { hasCrossContextLocks, outboxFlushLock, withLock } from './locks.js';

const defer = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => (release = resolve));
  return { promise, release };
};

/**
 * A conforming `navigator.locks`, so the platform branch runs everywhere.
 *
 * Web Locks arrived in Node 24; below that there is no `navigator.locks` at all, and gating the
 * platform suite on availability would mean the branch we actually own — *how we call the API* —
 * goes unexecuted on whichever Node the contributor happens to have. This implements the slice of
 * the spec that branch depends on: `ifAvailable` yields a null lock rather than rejecting, and
 * without it the request queues.
 */
function webLocksStub(): { locks: LockManager } {
  const held = new Map<string, Promise<unknown>>();

  const request = async (
    name: string,
    options: { ifAvailable?: boolean; signal?: AbortSignal },
    callback: (lock: unknown) => Promise<unknown>,
  ) => {
    const current = held.get(name);

    if (current && options.ifAvailable) return callback(null);

    const turn = (async () => {
      if (current) await current.catch(() => undefined);
      return callback({ name, mode: 'exclusive' });
    })();

    const settled = turn.catch(() => undefined);
    held.set(name, settled);
    try {
      return await turn;
    } finally {
      // Only clear it when nobody queued behind us, or we release someone else's turn.
      if (held.get(name) === settled) held.delete(name);
    }
  };

  return { locks: { request } as unknown as LockManager };
}

/**
 * The same suite against every path.
 *
 * The fallback — what a non-secure context or an older browser gets — has to behave identically
 * *within* a context, or the degradation is a behavior change rather than a reduction in scope.
 * Running one suite against all of them is what proves that.
 */
function behavesLikeALock(label: string, prepare: () => void) {
  describe(label, () => {
    let counter = 0;
    const name = () => `${label}:${counter++}`;

    afterEach(() => vi.unstubAllGlobals());

    it('runs the work and returns its value', async () => {
      prepare();
      expect(await withLock(name(), async () => 42)).toEqual({ acquired: true, value: 42 });
    });

    it('declines rather than waiting when the lock is held', async () => {
      // Waiting is wrong here: a flush queued behind another flush runs against a drained queue.
      prepare();
      const key = name();
      const gate = defer();
      const first = withLock(key, async () => {
        await gate.promise;
        return 'first';
      });

      expect(await withLock(key, async () => 'second')).toEqual({ acquired: false });

      gate.release();
      expect(await first).toEqual({ acquired: true, value: 'first' });
    });

    it('does not run the work at all when it declines', async () => {
      prepare();
      const key = name();
      const gate = defer();
      const work = vi.fn(async () => 'nope');
      const first = withLock(key, async () => {
        await gate.promise;
        return 'first';
      });

      await withLock(key, work);
      expect(work).not.toHaveBeenCalled();

      gate.release();
      await first;
    });

    it('releases the lock once the work finishes', async () => {
      prepare();
      const key = name();
      await withLock(key, async () => 'first');

      expect(await withLock(key, async () => 'second')).toEqual({ acquired: true, value: 'second' });
    });

    it('releases the lock when the work throws', async () => {
      prepare();
      const key = name();
      await expect(
        withLock(key, async () => {
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');

      // a lock a failed flush never gave back would wedge every later flush
      expect(await withLock(key, async () => 'after')).toEqual({ acquired: true, value: 'after' });
    });

    it('keeps separate names independent', async () => {
      prepare();
      const gate = defer();
      const first = withLock(name(), async () => {
        await gate.promise;
        return 'a';
      });

      expect(await withLock(name(), async () => 'b')).toEqual({ acquired: true, value: 'b' });

      gate.release();
      await first;
    });

    it('waits its turn when asked to', async () => {
      prepare();
      const key = name();
      const order: string[] = [];
      const gate = defer();

      const first = withLock(key, async () => {
        order.push('first-start');
        await gate.promise;
        order.push('first-end');
      });

      const second = withLock(key, async () => void order.push('second'), { ifAvailable: false });

      gate.release();
      await Promise.all([first, second]);

      expect(order).toEqual(['first-start', 'first-end', 'second']);
    });
  });
}

/** Node 24+ has the real API; below that only the stub and the fallback run. */
const platformHasLocks = hasCrossContextLocks();

behavesLikeALock('platform locks (stubbed manager)', () => {
  vi.stubGlobal('navigator', webLocksStub());
  expect(hasCrossContextLocks()).toBe(true);
});

describe.skipIf(!platformHasLocks)("platform locks (this runtime's own)", () => {
  behavesLikeALock('native navigator.locks', () => {
    expect(hasCrossContextLocks()).toBe(true);
  });
});

behavesLikeALock('in-process fallback', () => {
  vi.stubGlobal('navigator', {});
  expect(hasCrossContextLocks()).toBe(false);
});

describe('hasCrossContextLocks', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reports honestly whether exclusion spans tabs', () => {
    // Callers can tell the difference rather than assume it — the fallback excludes within one
    // JavaScript context and nothing more, which for realms means not at all.
    vi.stubGlobal('navigator', webLocksStub());
    expect(hasCrossContextLocks()).toBe(true);

    vi.stubGlobal('navigator', {});
    expect(hasCrossContextLocks()).toBe(false);
  });
});

describe('outboxFlushLock', () => {
  it('is per owner, so two applications do not serialize behind each other', () => {
    expect(outboxFlushLock('billing')).not.toBe(outboxFlushLock('reviews'));
  });

  it('is stable for one owner, so two tabs of it collide', () => {
    expect(outboxFlushLock('billing')).toBe(outboxFlushLock('billing'));
  });
});
