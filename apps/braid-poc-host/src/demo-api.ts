import type { Express, Request, Response } from 'express';

/**
 * The demo's data sources.
 *
 * **Reads come from a real public API.** SWAPI is genuinely third-party, genuinely over the
 * network, and obviously not something we control — which is exactly the point when the claim is
 * "these two independently deployed apps fetched this once between them".
 *
 * **Writes come from here.** SWAPI is read-only, and more importantly a demo needs *controllable*
 * latency and failure: the outbox panels demonstrate nothing without a switch that makes a request
 * slow, fail twice, or not arrive at all.
 *
 * **Fixtures are required, not optional.** A demo that breaks when a third-party API is down is
 * worse than no demo, and it will be down during the one meeting that matters. `DEMO_FIXTURES=1`
 * serves the committed copies and every panel behaves identically.
 */

/** Committed so the demo works with the network unplugged. Trimmed to what the panels render. */
const FIXTURES: Record<string, DemoCharacter> = {
  '1': { id: '1', name: 'Luke Skywalker', homeworld: 'Tatooine', starships: 5 },
  '2': { id: '2', name: 'C-3PO', homeworld: 'Tatooine', starships: 0 },
  '3': { id: '3', name: 'R2-D2', homeworld: 'Naboo', starships: 0 },
  '4': { id: '4', name: 'Darth Vader', homeworld: 'Tatooine', starships: 1 },
  '5': { id: '5', name: 'Leia Organa', homeworld: 'Alderaan', starships: 0 },
};

export interface DemoCharacter {
  id: string;
  name: string;
  homeworld: string;
  starships: number;
}

/** Latency and failure, switchable from the page so a panel can demonstrate a slow or dead server. */
interface MockBehavior {
  delayMs: number;
  /** Requests to fail before one succeeds. Decremented as they fail. */
  failTimes: number;
  /** When true, writes never arrive — what the offline panels switch on. */
  offline: boolean;
  /**
   * When true, the server stores a normalized version of what was submitted.
   *
   * A real server does this constantly — trims, title-cases, resolves an id, applies a rule the
   * client does not know about — and it is the case the conflict panel exists for. Accepting a
   * write and storing something else is not a failure, which is exactly why silently swapping the
   * value under the user is so easy to ship.
   */
  rewrite: boolean;
}

const behavior: MockBehavior = { delayMs: 0, failTimes: 0, offline: false, rewrite: false };

/** Edits applied by the demo, kept in memory. Reset with the demo's reset control. */
const edits = new Map<string, Partial<DemoCharacter>>();

export function mountDemoApi(app: Express): void {
  app.use('/api/demo', (_req, _res, next) => next());

  app.get('/api/demo/characters/:id', async (request: Request, response: Response) => {
    const id = request.params['id'] ?? '1';

    try {
      const character = { ...(await loadCharacter(id)), ...edits.get(id) };
      response.json(character);
    } catch (error) {
      response.status(502).json({ error: `could not load character ${id}: ${String(error)}` });
    }
  });

  /**
   * The write the outbox panels queue.
   *
   * Deliberately capable of being slow, failing, and disappearing — a mutation that always succeeds
   * instantly demonstrates nothing about a queue.
   */
  app.post('/api/demo/characters/:id', async (request: Request, response: Response) => {
    const id = request.params['id'] ?? '1';

    if (behavior.offline) {
      // Not a 5xx: the demo is simulating "the request never arrived", and a response saying so
      // would be a contradiction. Hanging until the client's own timeout is what offline feels like.
      response.socket?.destroy();
      return;
    }

    await delay(behavior.delayMs);

    if (behavior.failTimes > 0) {
      behavior.failTimes -= 1;
      response.status(503).json({ error: 'the server is having a moment', remaining: behavior.failTimes });
      return;
    }

    const submitted = request.body as Partial<DemoCharacter>;
    const patch =
      behavior.rewrite && typeof submitted.name === 'string'
        ? { ...submitted, name: submitted.name.toUpperCase() }
        : submitted;
    edits.set(id, { ...edits.get(id), ...patch });

    response.json({ ...(await loadCharacter(id)), ...edits.get(id) });
  });

  /** The demo's own control panel: what the latency/failure/offline switches write to. */
  app.post('/api/demo/behavior', (request: Request, response: Response) => {
    const next = request.body as Partial<MockBehavior>;
    if (typeof next.delayMs === 'number') behavior.delayMs = Math.max(0, Math.min(next.delayMs, 10_000));
    if (typeof next.failTimes === 'number') behavior.failTimes = Math.max(0, Math.min(next.failTimes, 10));
    if (typeof next.offline === 'boolean') behavior.offline = next.offline;
    if (typeof next.rewrite === 'boolean') behavior.rewrite = next.rewrite;
    response.json(behavior);
  });

  app.get('/api/demo/behavior', (_request: Request, response: Response) => response.json(behavior));

  /**
   * Resets server-side demo state.
   *
   * Persistence-first means the demo accumulates state across visits, so a reset is not a
   * convenience — without one the second visitor sees the first visitor's queue.
   */
  app.post('/api/demo/reset', (_request: Request, response: Response) => {
    edits.clear();
    behavior.delayMs = 0;
    behavior.failTimes = 0;
    behavior.offline = false;
    behavior.rewrite = false;
    response.json({ reset: true });
  });
}

async function loadCharacter(id: string): Promise<DemoCharacter> {
  if (process.env['DEMO_FIXTURES'] === '1') return fixture(id);

  try {
    const response = await fetch(`https://swapi.info/api/people/${id}`, {
      signal: AbortSignal.timeout(4000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const body = (await response.json()) as { name: string; homeworld: string; starships: string[] };
    return {
      id,
      name: body.name,
      // The API returns a URL; the demo shows a name, and resolving it would be a second request
      // this panel is specifically claiming not to make.
      homeworld: fixture(id).homeworld,
      starships: body.starships?.length ?? 0,
    };
  } catch {
    // A third-party outage must not take the demo down — this is the whole reason fixtures exist.
    return fixture(id);
  }
}

function fixture(id: string): DemoCharacter {
  return FIXTURES[id] ?? { id, name: `Unknown ${id}`, homeworld: 'Unknown', starships: 0 };
}

const delay = (ms: number) => (ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve());
