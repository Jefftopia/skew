import { Controller, Get, Header, NotFoundException, Param } from '@nestjs/common';
import { findFund, funds } from './mock-data';
import { toFundV2 } from './to-v2';
import { fundLens } from './fund-contract';

/**
 * The v1 fund contract — what the host build understands.
 *
 * v1 is no longer written by hand: the canonical record is v2 (that is what
 * the business now knows about a fund), and this endpoint is the contract's
 * *down* direction run over it. The projection and the published contract
 * document literally share one definition, so a client that fetches the
 * document and down-migrates gets byte-for-byte what this endpoint would have
 * served — mid-migration, provably in sync.
 *
 * The response body remains a hand-written `{ v, payload }` envelope — the
 * envelope shape is the contract, and nothing requires a server to construct
 * it through `@skew/core`. The `Skew-Contract` header names the document a
 * consumer can fetch to learn the rest.
 */
const clock = { now: () => new Date() };

function toFundV1(id: string): unknown {
  const fund = findFund(id);
  if (!fund) return undefined;
  return fundLens.down?.(toFundV2(fund, new Date().toISOString()), clock);
}

@Controller('v1/funds')
export class FundsV1Controller {
  @Get()
  @Header('skew-contract', '</api/.well-known/skew/contracts/portfolio-fund>; v=1')
  list() {
    return {
      v: 1,
      payload: funds.map((f) => toFundV1(f.id)),
    };
  }

  @Get(':id')
  @Header('skew-contract', '</api/.well-known/skew/contracts/portfolio-fund>; v=1')
  one(@Param('id') id: string) {
    const fund = toFundV1(id);
    if (!fund) throw new NotFoundException(`no fund "${id}"`);
    return { v: 1, payload: fund };
  }
}
