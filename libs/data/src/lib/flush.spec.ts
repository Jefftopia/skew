import { versioned } from '@braidlabs/skew';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInvalidator, resetSharedInvalidators } from './invalidation.js';
import { memoryRecordDriver } from './memory-driver.js';
import { createOutbox } from './outbox.js';
import { outboxFlushLock, withLock } from './locks.js';
import { createDataClient } from './query.js';
import type { RecordDriver } from './record-store.js';

/**
 * Replaying what the queue is holding.
 *
 * A queue nothing drains is durability without delivery — the worse half of the feature, because it
 * looks like it works: the write is visibly kept, the user is told it saved, and it never arrives.
 */

interface Note {
  id: string;
  title: string;
}

const NoteContract = versioned<Note>('flush-spec-note');

function setup(options: { driver?: RecordDriver; maxAttempts?: number; autoFlush?: boolean } = {}) {
  const driver = options.driver ?? memoryRecordDriver();
  const errors: string[] = [];
  const client = createDataClient({
    driver,
    partition: () => 'demo',
    collection: 'entities',
    invalidator: createInvalidator({ partition: 'demo' }),
    outbox: createOutbox({ driver, owner: 'notes', collection: 'outbox' }),
    onFlushError: (message) => errors.push(message),
    ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
    // Off by default in these tests so each one drives the flush itself; the construction-time
    // flush is covered separately.
    autoFlush: options.autoFlush ?? false,
  });
  return { client, driver, errors };
}

const rename = (send: (input: unknown) => Promise<unknown>, title = 'Buy oat milk') => ({
  key: 'note:n1',
  schema: NoteContract,
  mutationId: 'note.rename',
  input: { id: 'n1', title },
  patch: { title },
  tags: ['note#n1'],
  send,
});

afterEach(() => resetSharedInvalidators());

describe('replaying a queued write', () => {
  it('sends what a failed attempt left behind', async () => {
    const { client } = setup();
    let online = false;
    const send = vi.fn(async (input: unknown) => {
      if (!online) throw new TypeError('Failed to fetch');
      return { ...(input as Note) };
    });

    const outcome = await client.mutate(rename(send));
    expect(outcome.status).toBe('queued');

    online = true;
    const flushed = await client.flush();

    expect(flushed).toEqual({ sent: 1, failed: 0, remaining: 0, skipped: false });
    // The same function, called again with the stored input — which is why `send` takes it.
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith({ id: 'n1', title: 'Buy oat milk' }, expect.anything());

    client.close();
  });

  it('needs no registration for a write made in this session', async () => {
    // `mutate` registers its own sender, so the live path is not asked to repeat itself.
    const { client } = setup();
    let online = false;
    await client.mutate(
      rename(async (input) => {
        if (!online) throw new TypeError('Failed to fetch');
        return input;
      }),
    );

    online = true;
    expect((await client.flush()).sent).toBe(1);

    client.close();
  });

  it('replays what a *previous* session queued, once the kind is registered', async () => {
    const driver = memoryRecordDriver();
    const first = setup({ driver });
    await first.client.mutate(
      rename(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    first.client.close();

    // The reload: nothing in memory survives, and the closure that queued the write is gone.
    const second = setup({ driver });
    const send = vi.fn(async (input: unknown) => input);
    second.client.registerMutation('note.rename', send, { tags: ['note#n1'] });

    expect((await second.client.flush()).sent).toBe(1);
    expect(send).toHaveBeenCalledWith({ id: 'n1', title: 'Buy oat milk' }, expect.anything());

    second.client.close();
  });

  it('keeps an entry it has no runner for, and says so', async () => {
    const driver = memoryRecordDriver();
    const first = setup({ driver });
    await first.client.mutate(
      rename(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    first.client.close();

    // A reload where the app forgot to re-register, or renamed the mutation between deploys.
    const second = setup({ driver });
    const flushed = await second.client.flush();

    // Dropping it would discard a write the user was told had saved.
    expect(flushed.sent).toBe(0);
    expect(flushed.remaining).toBe(1);
    expect(second.errors[0]).toContain('no registered mutation for "note.rename"');

    second.client.close();
  });
});

describe('ordering and give-up', () => {
  it('stops at the first failure rather than skipping ahead', async () => {
    const { client } = setup();
    const sent: string[] = [];
    let allowed = 0;

    const send = async (input: unknown) => {
      const note = input as Note;
      if (sent.length >= allowed) throw new TypeError('Failed to fetch');
      sent.push(note.title);
      return note;
    };

    client.registerMutation('note.rename', send);
    await client.mutate(rename(send, 'first'));
    await client.mutate(rename(send, 'second'));

    allowed = 1;
    const flushed = await client.flush();

    // Queued writes routinely depend on each other, so a failure stops the drain.
    expect(sent).toEqual(['first']);
    expect(flushed).toMatchObject({ sent: 1, failed: 1, remaining: 1 });

    client.close();
  });

  it('abandons an entry loudly once it has failed too often', async () => {
    const { client, errors } = setup({ maxAttempts: 2 });
    const send = async () => {
      throw new Error('the server hates this write');
    };

    await client.mutate(rename(send));
    await client.flush();
    const second = await client.flush();

    expect(second.remaining).toBe(0);
    expect(errors.some((message) => message.includes('giving up on "note.rename"'))).toBe(true);

    client.close();
  });
});

describe('automatic flushing', () => {
  it('drains a queue left by a previous session at construction', async () => {
    const driver = memoryRecordDriver();
    const first = setup({ driver });
    await first.client.mutate(
      rename(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    first.client.close();

    const send = vi.fn(async (input: unknown) => input);
    const second = setup({ driver, autoFlush: true });
    second.client.registerMutation('note.rename', send);
    // Registration happens after construction, so the construction-time flush finds no runner and
    // leaves the entry queued — this is the reload path, and the next trigger is what sends it.
    await second.client.flush();

    expect(send).toHaveBeenCalledOnce();
    second.client.close();
  });

  it('flushes when the browser says the network is back', async () => {
    // Node's globalThis is not an EventTarget, so the client correctly installs no listener there.
    // The shim is what a browser provides, and the point of the test is the wiring in between.
    const events = new EventTarget();
    const original = {
      addEventListener: (globalThis as Record<string, unknown>)['addEventListener'],
      dispatchEvent: (globalThis as Record<string, unknown>)['dispatchEvent'],
    };
    Object.assign(globalThis, {
      addEventListener: events.addEventListener.bind(events),
      dispatchEvent: events.dispatchEvent.bind(events),
    });

    try {
      const { client } = setup({ autoFlush: true });
      let online = false;
      const send = vi.fn(async (input: unknown) => {
        if (!online) throw new TypeError('Failed to fetch');
        return input;
      });

      await client.mutate(rename(send));
      expect(send).toHaveBeenCalledTimes(1);

      online = true;
      events.dispatchEvent(new Event('online'));
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(send).toHaveBeenCalledTimes(2);
      client.close();
    } finally {
      Object.assign(globalThis, original);
    }
  });
});

describe('overlapping flushes', () => {
  it('waits for the start-up flush instead of reporting the caller skipped', async () => {
    // The trap this exists for: construct a client, queue a write, flush — and the flush the client
    // fired at construction is very likely still finishing, so a cross-tab "someone else is on it"
    // rule would report `skipped` and quietly do nothing with the user's write.
    const { client } = setup({ autoFlush: true });
    let online = false;
    const send = vi.fn(async (input: unknown) => {
      if (!online) throw new TypeError('Failed to fetch');
      return input;
    });

    await client.mutate(rename(send));
    online = true;

    const flushed = await client.flush();

    expect(flushed.skipped).toBe(false);
    expect(flushed.sent).toBe(1);
    client.close();
  });

  it('reports skipped only when another context already holds the lock', async () => {
    const { client } = setup();
    await client.mutate(
      rename(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );

    // Another tab, mid-drain. Held directly, because the point under test is what *this* client
    // does when the lock is already taken.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const other = withLock(outboxFlushLock('entities'), () => held, { ifAvailable: false });
    await new Promise((resolve) => setTimeout(resolve, 5));

    const flushed = await client.flush();

    // Declined rather than queued: waiting would drain a queue the other context has already
    // emptied, replaying writes it just sent.
    expect(flushed.skipped).toBe(true);
    expect(flushed.remaining).toBe(1);

    release();
    await other;
    client.close();
  });
});
