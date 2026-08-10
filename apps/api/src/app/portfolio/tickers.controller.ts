import { Controller, Get } from '@nestjs/common';
import { TICKER_UNIVERSE } from './ticker.gateway';

/**
 * The tradeable universe, for the client's typeahead.
 *
 * Served rather than hardcoded in the two Angular apps so both get the same
 * list from the same place — this is reference data, not a contract that
 * skews, so there is nothing to version here.
 *
 * Every ticker is offered for every fund. In a real system the universe would
 * be constrained per mandate; for the demo, an unconstrained list keeps the
 * interesting part (what happens to an *order* across a version boundary)
 * from being buried under eligibility rules that teach nothing.
 */
@Controller('v1/tickers')
export class TickersController {
  @Get()
  list() {
    return { v: 1, payload: TICKER_UNIVERSE };
  }
}
