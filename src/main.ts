import { NestFactory } from '@nestjs/core';
import { BadRequestException, UnprocessableEntityException, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { WinstonModule } from 'nest-winston';
import * as winston from 'winston';
import { AppModule } from './app.module';
import { corsOptions } from './config/cors.config';
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

  app.use(
    helmet({
      contentSecurityPolicy: nodeEnv === 'production' ? undefined : false,
      crossOriginEmbedderPolicy: false,
    }),
  );

  app.setGlobalPrefix('api/v1');

  app.useGlobalFilters(new AllExceptionsFilter(logger, nodeEnv === 'production'));
  app.useGlobalInterceptors(new LoggingInterceptor(logger, nodeEnv), new TransformInterceptor());

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      exceptionFactory: (errors) => {
        const hasWeightSumViolation = errors.some(
          (error) =>
            Object.prototype.hasOwnProperty.call(error.constraints ?? {}, 'WeightSumConstraint') ||
            Object.prototype.hasOwnProperty.call(error.constraints ?? {}, 'ValidateCreditWeights'),
        );

        return hasWeightSumViolation
          ? new UnprocessableEntityException(errors)
          : new BadRequestException(errors);
      },
    }),
  );

  app.enableCors({
    ...corsOptions,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  });

  if (nodeEnv !== 'production') {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('Water Credits API')
      .setDescription(
        'Off-chain orchestration layer for the Water Quality & Replenishment Credits protocol.',
      )
      .setVersion('0.1.0')
      .addTag('auth', 'Stellar wallet authentication')
      .addTag('users', 'User profiles and role management')
      .addTag('projects', 'Watershed restoration projects')
      .addTag('sensors', 'Sensor device registration and reading ingestion')
      .addTag('credits', 'Credit balances, retirements, and certificates')
      .addTag('oracle', 'Oracle node submissions')
      .addTag('governance', 'Proposals and protocol configuration')
      .addTag('analytics', 'Aggregated dashboard metrics')
      .addTag('notifications', 'In-app user notifications')
      .addTag('health', 'Liveness, readiness, and health reporting')
      .addBearerAuth()
      .addApiKey({ type: 'apiKey', in: 'header', name: 'X-API-Key' }, 'api-key')
      .build();
    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('api/docs', app, document);
  }

  // Required for OnApplicationShutdown to run on SIGTERM/SIGINT — without it
  // the oracle submission cron would keep firing while a pod drains.
  app.enableShutdownHooks();

  // WebSocket Redis adapters are owned by their gateway namespaces rather than
  // configured globally. SensorsGateway awaits Redis readiness during module
  // initialization and retains Socket.IO's in-process adapter on startup failure.
  await app.listen(port);
  logger.log(`Server running on port ${port} in ${nodeEnv} mode`, 'Bootstrap');
}

bootstrap();
