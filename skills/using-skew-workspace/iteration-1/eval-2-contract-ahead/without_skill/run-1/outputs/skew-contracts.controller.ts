/**
 * Publishes Skew contract documents at the well-known URL:
 *
 *   GET /.well-known/skew/contracts/:name
 *
 * A contract document changes only when the API ships a new schema version,
 * so it is served with a strong ETag derived from the document itself plus a
 * short max-age with stale-while-revalidate. Clients (the @skewkit/contract
 * resolver) revalidate cheaply with If-None-Match and get a 304 when nothing
 * has changed.
 */
import {
  Controller,
  Get,
  Header,
  Headers,
  HttpStatus,
  NotFoundException,
  Param,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { createHash } from 'node:crypto';

// The contract document is data, checked into the repo next to the API.
// (resolveJsonModule: true — or read the file at bootstrap if you prefer.)
import * as portfolioFundContract from './portfolio-fund.contract.json';

interface PublishedContract {
  body: string; // pre-serialized JSON
  etag: string; // strong ETag over the exact bytes served
}

function publish(doc: unknown): PublishedContract {
  const body = JSON.stringify(doc);
  const etag = `"${createHash('sha256').update(body).digest('base64url')}"`;
  return { body, etag };
}

@Controller('.well-known/skew/contracts')
export class SkewContractsController {
  // Serialize + hash once at construction, not per request.
  private readonly contracts = new Map<string, PublishedContract>([
    ['portfolio-fund', publish(portfolioFundContract)],
  ]);

  @Get(':name')
  @Header('Content-Type', 'application/json; charset=utf-8')
  // Contract documents are immutable per version but the "latest" pointer can
  // move on deploy: cache briefly, allow shared caches, revalidate in the
  // background rather than blocking readers.
  @Header('Cache-Control', 'public, max-age=300, stale-while-revalidate=86400')
  getContract(
    @Param('name') name: string,
    @Headers('if-none-match') ifNoneMatch: string | undefined,
    @Res() res: Response,
  ): void {
    const contract = this.contracts.get(name);
    if (!contract) {
      throw new NotFoundException(`No skew contract published for "${name}"`);
    }

    res.setHeader('ETag', contract.etag);
    // Contract fetches happen from browsers/mobile webviews on other origins.
    res.setHeader('Access-Control-Allow-Origin', '*');

    if (ifNoneMatch && ifNoneMatch === contract.etag) {
      res.status(HttpStatus.NOT_MODIFIED).end();
      return;
    }

    res.status(HttpStatus.OK).send(contract.body);
  }
}
