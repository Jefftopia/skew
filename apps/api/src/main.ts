/**
 * This is not a production server yet!
 * This is only a minimal backend to get started.
 */

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WsAdapter } from '@nestjs/platform-ws';
import { AppModule } from './app/app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const globalPrefix = 'api';
  app.setGlobalPrefix(globalPrefix);

  // The federated demo apps run on 4410 (host), 4411 (remote, standalone),
  // and 4420 (the same-origin server) — all three need to call this API.
  app.enableCors({
    origin: [
      'http://localhost:4410',
      'http://localhost:4411',
      'http://localhost:4420',
    ],
  });

  // Plain `ws`, not socket.io — socket.io would add a client dependency to
  // both Angular apps for a feature the native `WebSocket` already covers.
  app.useWebSocketAdapter(new WsAdapter(app));

  const port = process.env.PORT || 3333;
  await app.listen(port);
  Logger.log(
    `🚀 Application is running on: http://localhost:${port}/${globalPrefix}`,
  );
}

bootstrap();
