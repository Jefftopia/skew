import { Controller, MessageEvent, Post, Sse } from '@nestjs/common';
import { Observable, Subject, map } from 'rxjs';
import { BreachService, LiquidityBreachV1 } from './breach.service';

/**
 * Breaches are fanned out to every open connection from here.
 *
 * Module-level rather than per-request: a `@Sse` handler runs once per client,
 * so a Subject created inside it would only ever talk to that one client, and
 * a breach fired from the UI would reach whichever tab happened to POST it.
 */
const breaches = new Subject<LiquidityBreachV1>();

@Controller('events')
export class EventsController {
  constructor(private readonly service: BreachService) {}

  /**
   * The stream fires **only when something asks it to** — there is no timer.
   *
   * It used to emit on a random 3–15s interval, which made the tab feel alive
   * and made it impossible to answer "did that happen because I clicked
   * something, or would it have happened anyway?". For a demo whose whole
   * subject is cause and effect across a boundary, an event you did not
   * trigger is noise wearing the costume of a feature.
   */
  @Sse('liquidity')
  liquidity(): Observable<MessageEvent> {
    return breaches.pipe(
      map(
        (breach) =>
          ({ data: { v: 1, payload: breach } }) satisfies MessageEvent,
      ),
    );
  }

  /** Fires one breach to every connected client. Wired to a button in the UI. */
  @Post('liquidity/trigger')
  trigger() {
    const breach = this.service.generate();
    breaches.next(breach);
    return { v: 1, payload: breach };
  }
}
