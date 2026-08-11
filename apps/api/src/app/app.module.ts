import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { FundsV1Controller } from './portfolio/funds-v1.controller';
import { FundsV2Controller } from './portfolio/funds-v2.controller';
import { ContractsController } from './portfolio/contracts.controller';
import { EventsController } from './portfolio/events.controller';
import { BreachService } from './portfolio/breach.service';
import { TickerGateway } from './portfolio/ticker.gateway';
import { TickersController } from './portfolio/tickers.controller';
import { AdminController } from './admin.controller';
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
    ContractsController,
    EventsController,
    OrdersV1Controller,
    OrdersV2Controller,
    TickersController,
    AdminController,
  ],
  providers: [AppService, BreachService, TickerGateway],
})
export class AppModule {}
