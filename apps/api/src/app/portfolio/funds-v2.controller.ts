import { Controller, Get, Header, NotFoundException, Param } from '@nestjs/common';
import { findFund, funds } from './mock-data';
import { toFundV2 } from './to-v2';

/**
 * The v2 fund contract — what the remote build understands. Served
 * *simultaneously* with v1 from the same process: two live API versions, two
 * clients pinned to different ones, same as a real deploy where the host and
 * the remote were built weeks apart against different contracts.
 */
@Controller('v2/funds')
export class FundsV2Controller {
  @Get()
  @Header('skew-contract', '</api/.well-known/skew/contracts/portfolio-fund>; v=2')
  list() {
    const asOf = new Date().toISOString();
    return { v: 2, payload: funds.map((f) => toFundV2(f, asOf)) };
  }

  @Get(':id')
  @Header('skew-contract', '</api/.well-known/skew/contracts/portfolio-fund>; v=2')
  one(@Param('id') id: string) {
    const fund = findFund(id);
    if (!fund) throw new NotFoundException(`no fund "${id}"`);
    return { v: 2, payload: toFundV2(fund, new Date().toISOString()) };
  }
}
