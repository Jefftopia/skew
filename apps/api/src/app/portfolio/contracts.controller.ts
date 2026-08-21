import { Controller, Get, Headers, NotFoundException, Param, Res } from '@nestjs/common';
import type { Response } from 'express';
import { contractFingerprint } from '@braid/contract';
import { FUND_CONTRACT } from './fund-contract';

/**
 * Publishes contract documents at the well-known location.
 *
 * This endpoint is what turns `ahead` from a dead end into a solvable state:
 * a client older than the data it was handed fetches the contract *from the
 * origin that produced that data* — an origin that is, by construction, at
 * least as new — and learns the steps it shipped too early to know.
 *
 * The fingerprint doubles as the ETag, so clients revalidate for free and a
 * contract that has not changed costs a 304.
 */
@Controller('.well-known/skew/contracts')
export class ContractsController {
  private readonly documents = new Map([[FUND_CONTRACT.name, FUND_CONTRACT]]);

  @Get(':name')
  one(
    @Param('name') name: string,
    @Headers('if-none-match') ifNoneMatch: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const doc = this.documents.get(name);
    if (!doc) throw new NotFoundException(`no contract "${name}" published here`);

    const etag = `"${contractFingerprint(doc)}"`;
    res.setHeader('etag', etag);
    res.setHeader('cache-control', 'no-cache');
    if (ifNoneMatch === etag) {
      res.status(304);
      return undefined;
    }
    return doc;
  }
}
