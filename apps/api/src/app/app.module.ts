import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { FundsV1Controller } from './portfolio/funds-v1.controller';
import { FundsV2Controller } from './portfolio/funds-v2.controller';
import { EventsController } from './portfolio/events.controller';
import { BreachService } from './portfolio/breach.service';
import { TickerGateway } from './portfolio/ticker.gateway';
import { TickersController } from './portfolio/tickers.controller';
import {
  OrdersV1Controller,
  OrdersV2Controller,
} from './portfolio/orders.controller';

@Module({
  imports: [],
  controllers: [
    AppController,
    FundsV1Controller,
    FundsV2Controller,
    EventsController,
    OrdersV1Controller,
    OrdersV2Controller,
    TickersController,
  ],
  providers: [AppService, BreachService, TickerGateway],
})
export class AppModule {}
