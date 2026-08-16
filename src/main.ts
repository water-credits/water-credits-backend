import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WinstonModule } from 'nest-winston';
import * as winston from 'winston';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { TransformInterceptor } from './common/interceptors/transform.interceptor';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';

async function bootstrap() {
  const logFormat = process.env.LOG_FORMAT ?? 'pretty';
  const logger = WinstonModule.createLogger({
    format:
      logFormat === 'json'
        ? winston.format.combine(winston.format.timestamp(), winston.format.json())
        : winston.format.combine(
            winston.format.timestamp(),
            winston.format.colorize(),
            winston.format.simple(),
          ),
    transports: [new winston.transports.Console()],
  });
  const app = await NestFactory.create(AppModule, { logger });

  const configService = app.get(ConfigService);
  const port = configService.get<number>('PORT', 3001);
  const nodeEnv = configService.get<string>('NODE_ENV', 'development');

  app.setGlobalPrefix('api/v1');

  app.useGlobalFilters(new AllExceptionsFilter(logger));
  app.useGlobalInterceptors(new LoggingInterceptor(logger, nodeEnv), new TransformInterceptor());

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  app.enableCors({
    origin: nodeEnv === 'production' ? process.env.CORS_ORIGIN : '*',
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    credentials: true,
  });

  // The Socket.io Redis adapter is initialised per-gateway namespace inside each
  // gateway's afterInit() hook (NotificationsGateway, SensorsGateway).  This
  // guarantees the adapter is attached before the first client can connect and
  // allows each namespace to share the same Redis pub/sub channel prefix while
  // maintaining namespace isolation.  No top-level adapter configuration is
  // required here.
  await app.listen(port);
  logger.log(`Server running on port ${port} in ${nodeEnv} mode`, 'Bootstrap');
}

bootstrap();
