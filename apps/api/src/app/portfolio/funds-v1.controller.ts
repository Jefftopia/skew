import { Controller, Get, NotFoundException, Param } from '@nestjs/common';
import { findFund, funds } from './mock-data';

/**
 * The v1 fund contract — what the host build understands.
 *
 * The response body is a hand-written `{ v, payload }` envelope, not one
 * produced by `@skew/core`. The server is a separate deployment from every
 * consumer and must not share code with them; the envelope shape is the
 * contract, and `@skew/core` is one implementation of reading it, not the only
 * one that is allowed to write it.
 */
@Controller('v1/funds')
export class FundsV1Controller {
  @Get()
  list() {
    return { v: 1, payload: funds };
  }

  @Get(':id')
  one(@Param('id') id: string) {
    const fund = findFund(id);
    if (!fund) throw new NotFoundException(`no fund "${id}"`);
    return { v: 1, payload: fund };
  }
}
