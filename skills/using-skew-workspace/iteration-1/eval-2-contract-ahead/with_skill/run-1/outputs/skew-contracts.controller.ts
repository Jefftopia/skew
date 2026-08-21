/**
 * NestJS controllers for the portfolio-fund contract.
 *
 * 1. SkewContractsController publishes contract documents at the well-known
 *    URL:  GET /.well-known/skew/contracts/:name
 *    Caching: the contract fingerprint is the ETag, with
 *    `Cache-Control: no-cache`. "no-cache" means "revalidate before reuse",
 *    NOT "don't cache" — so an unchanged contract costs clients a 304 and no
 *    body, while a newly-appended step is picked up on the very next request.
 *    (Never use long max-age here: a stale contract is exactly the failure
 *    this endpoint exists to cure. Never use no-store either: a cached copy
 *    still beats none when the origin is briefly unreachable.)
 *
 * 2. PortfolioFundsController shows the companion convention: every response
 *    that carries a versioned body also sends the `skew-contract` header
 *    pointing at the contract that explains it, so clients discover the URL
 *    without hardcoding it.
 *
 * @braid/contract is framework-free and dependency-free, so it runs inside
 * Nest directly — no @braid/nest package is needed (or shipped).
 */
import {
  Controller,
  Get,
  Headers,
  NotFoundException,
  Param,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { contractFingerprint, wellKnownContractUrl } from '@braid/contract';
import { formatSkewContractHeader, SKEW_CONTRACT_HEADER } from '@braid/skew';
import {
  FundV2,
  PORTFOLIO_FUND_CONTRACT,
} from './generated/portfolio-fund.contract';

/** All contract documents this origin publishes, keyed by contract name. */
const DOCUMENTS = new Map<string, object>([
  [PORTFOLIO_FUND_CONTRACT.name, PORTFOLIO_FUND_CONTRACT],
]);

@Controller('.well-known/skew/contracts')
export class SkewContractsController {
  @Get(':name')
  one(
    @Param('name') name: string,
    @Headers('if-none-match') ifNoneMatch: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): object | undefined {
    const doc = DOCUMENTS.get(name);
    if (!doc) {
      throw new NotFoundException(`no contract "${name}" published here`);
    }

    // Content-derived ETag: changes exactly when the document changes.
    const etag = `"${contractFingerprint(doc)}"`;
    res.setHeader('etag', etag);
    res.setHeader('cache-control', 'no-cache');

    if (ifNoneMatch === etag) {
      res.status(304);
      return undefined; // 304 must carry no body
    }
    return doc;
  }
}

/**
 * The resource controller. Bodies are served at the CURRENT version (v2);
 * old clients are not special-cased here — they cure themselves via the
 * published contract. The skew-contract header is how they find it.
 */
@Controller('portfolio-funds')
export class PortfolioFundsController {
  constructor(private readonly funds: PortfolioFundService) {}

  @Get(':id')
  async one(
    @Param('id') id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<FundV2> {
    res.setHeader(
      SKEW_CONTRACT_HEADER, // 'skew-contract'
      formatSkewContractHeader({
        name: PORTFOLIO_FUND_CONTRACT.name,
        version: PORTFOLIO_FUND_CONTRACT.current,
        url: wellKnownContractUrl('', PORTFOLIO_FUND_CONTRACT.name),
      }),
    );
    return this.funds.findOne(id);
  }
}

/** Stand-in for the real data service; returns current-shape (v2) funds. */
export abstract class PortfolioFundService {
  abstract findOne(id: string): Promise<FundV2>;
}
