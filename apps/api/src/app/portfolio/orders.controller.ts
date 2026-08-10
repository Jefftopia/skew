import { Body, ConflictException, Controller, Get, Post } from '@nestjs/common';

/**
 * Two live order contracts, same as the funds endpoints — and this is the row
 * the rest of the demo does not cover: a mutation queued by a client, flushed
 * later against a server that has moved on. `/v1/orders` accepts the old
 * shape as itself; `/v2/orders` accepts only v2 and refuses v1 outright.
 */

export interface OrderV1 {
  fundId: string;
  action: 'raise-cash' | 'sell-holding' | 'defer-redemption';
  ticker?: string;
  amount: number;
  note?: string;
}

export interface OrderV2 {
  fundId: string;
  action: 'raise-cash' | 'sell-holding' | 'defer-redemption';
  ticker?: string;
  amount: { value: number; currency: string };
  note?: string;
  breachRef: string;
  idempotencyKey: string;
}

interface EnvelopeV1 {
  v: 1;
  payload: OrderV1;
}

interface AcceptedOrder {
  orderId: string;
  accepted: true;
  receivedAt: string;
}

let orderCounter = 0;
const acceptedV1: Array<{ v: 1; payload: OrderV1 & AcceptedOrder }> = [];
const acceptedV2: Array<{ v: 2; payload: OrderV2 & AcceptedOrder }> = [];
/** Dedupes retries carrying the same `idempotencyKey` after a 409-then-retry. */
const seenIdempotencyKeys = new Set<string>();

@Controller('v1/orders')
export class OrdersV1Controller {
  @Get()
  list() {
    return { v: 1, payload: acceptedV1.map((e) => e.payload) };
  }

  @Post()
  create(@Body() body: EnvelopeV1) {
    orderCounter += 1;
    const accepted: OrderV1 & AcceptedOrder = {
      ...body.payload,
      orderId: `ORD-V1-${orderCounter}`,
      accepted: true,
      receivedAt: new Date().toISOString(),
    };
    acceptedV1.push({ v: 1, payload: accepted });
    return { v: 1, payload: accepted };
  }
}

@Controller('v2/orders')
export class OrdersV2Controller {
  @Get()
  list() {
    return { v: 2, payload: acceptedV2.map((e) => e.payload) };
  }

  @Post()
  create(@Body() body: { v: number; payload: unknown }) {
    // The server never "helpfully" upgrades a v1 body — that would coerce a
    // real disagreement into a false success. It refuses and names the gap;
    // the client is the one that knows how to migrate its own queued payload.
    if (body.v !== 2) {
      throw new ConflictException({
        error: 'version-skew',
        expected: 2,
        received: body.v,
        message: `Order was authored against contract v${body.v}; this endpoint requires v2.`,
      });
    }

    const payload = body.payload as OrderV2;

    if (seenIdempotencyKeys.has(payload.idempotencyKey)) {
      const existing = acceptedV2.find(
        (e) => e.payload.idempotencyKey === payload.idempotencyKey,
      );
      if (existing) return existing;
    }
    seenIdempotencyKeys.add(payload.idempotencyKey);

    orderCounter += 1;
    const accepted: OrderV2 & AcceptedOrder = {
      ...payload,
      orderId: `ORD-V2-${orderCounter}`,
      accepted: true,
      receivedAt: new Date().toISOString(),
    };
    acceptedV2.push({ v: 2, payload: accepted });
    return { v: 2, payload: accepted };
  }
}
