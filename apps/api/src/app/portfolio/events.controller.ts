import { Controller, MessageEvent, Post, Sse } from '@nestjs/common';
import { Observable, Subject, merge, timer } from 'rxjs';
import { expand, map, skip } from 'rxjs/operators';
import { BreachService, LiquidityBreachV1 } from './breach.service';

const MIN_DELAY_MS = 3_000;
const MAX_DELAY_MS = 15_000;

function randomDelay(): number {
  return MIN_DELAY_MS + Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS);
}

/**
 * A random-interval stream, built by re-arming a `timer()` after each tick
 * rather than a fixed `interval()` — the requirement is a *range* per gap
 * (no sooner than `MIN_DELAY_MS`, no later than `MAX_DELAY_MS`), not a fixed
 * cadence.
 *
 * `expand()`, not `concatMap()`: `concatMap` only transforms the ONE value
 * `timer(0)` emits — the result fires once, after one random delay, and then
 * *completes*, because nothing re-subscribes it. `expand` is the operator
 * that recurses — it feeds every value the projection emits back into the
 * same projection, forever, which is what "re-arm after each tick" actually
 * requires. The source's own `0` at t=0 is skipped; the caller already emits
 * an immediate breach on connect, and this function should only contribute
 * the scheduled ones.
 */
function randomBreachStream(
  generate: () => LiquidityBreachV1,
): Observable<LiquidityBreachV1> {
  return timer(0).pipe(
    expand(() => timer(randomDelay())),
    skip(1),
    map(() => generate()),
  );
}

/**
 * Demo-only: without a way to fire a breach on demand, testing this stream
 * means waiting out a random delay up to `MAX_DELAY_MS`. Every connected
 * client receives triggered breaches via this shared Subject, merged into
 * their own random-interval stream below.
 */
const manualTrigger = new Subject<LiquidityBreachV1>();

@Controller('events')
export class EventsController {
  constructor(private readonly breaches: BreachService) {}

  @Sse('liquidity')
  liquidity(): Observable<MessageEvent> {
    // One breach immediately on connect, so opening the page does not stare at
    // nothing for up to MAX_DELAY_MS — a demo affordance, not steady-state
    // behaviour (steady-state is the MIN_DELAY_MS–MAX_DELAY_MS range starting
    // from the *first* scheduled tick below).
    const immediate = timer(0).pipe(map(() => this.breaches.generate()));
    const scheduled = randomBreachStream(() => this.breaches.generate());

    return merge(immediate, scheduled, manualTrigger).pipe(
      map(
        (breach) =>
          ({ data: { v: 1, payload: breach } }) satisfies MessageEvent,
      ),
    );
  }

  /** Demo-only debug hook — fires a breach to every connected client now. */
  @Post('liquidity/trigger')
  trigger() {
    const breach = this.breaches.generate();
    manualTrigger.next(breach);
    return { v: 1, payload: breach };
  }
}
