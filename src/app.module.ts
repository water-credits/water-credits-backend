import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bull';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { ScheduleModule } from '@nestjs/schedule';
import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { ProjectsModule } from './modules/projects/projects.module';
import { SensorsModule } from './modules/sensors/sensors.module';
import { CreditsModule } from './modules/credits/credits.module';
import { OracleModule } from './modules/oracle/oracle.module';
import { GovernanceModule } from './modules/governance/governance.module';
import { AnalyticsModule } from './modules/analytics/analytics.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { StellarModule } from './modules/stellar/stellar.module';
import { HealthModule } from './modules/health/health.module';
import { IndexerModule } from './modules/indexer/indexer.module';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { RolesGuard } from './common/guards/roles.guard';
import appConfig from './config/app.config';
import databaseConfig from './config/database.config';
import stellarConfig from './config/stellar.config';
import jwtConfig from './config/jwt.config';
import queueConfig from './config/queue.config';
import oracleConfig from './config/oracle.config';
import sensorConfig from './config/sensor.config';
import emailConfig from './config/email.config';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [
        appConfig,
        databaseConfig,
        stellarConfig,
        jwtConfig,
        queueConfig,
        oracleConfig,
        sensorConfig,
        emailConfig,
      ],
    }),
    TypeOrmModule.forRootAsync({
      useFactory: (configService: ConfigService) => ({
        type: 'postgres',
        host: configService.get('database.host'),
        port: configService.get('database.port'),
        username: configService.get('database.username'),
        password: configService.get('database.password'),
        database: configService.get('database.database'),
        ssl: configService.get('database.ssl'),
        autoLoadEntities: true,
        synchronize: configService.get('app.nodeEnv') !== 'production',
      }),
      inject: [ConfigService],
    }),
    BullModule.forRootAsync({
      useFactory: (configService: ConfigService) => ({
        redis: {
          host: configService.get('queue.redisHost'),
          port: configService.get('queue.redisPort'),
          password: configService.get('queue.redisPassword') || undefined,
        },
      }),
      inject: [ConfigService],
    }),
    // Default rate limit: 60 req / 60 s for authenticated routes.
    // Override per-route with @ThrottlePublic(), @ThrottleSensor(), etc.
    ThrottlerModule.forRootAsync({
      useFactory: (configService: ConfigService) => [
        {
          name: 'default',
          ttl: configService.get<number>('THROTTLE_TTL', 60000),
          limit: configService.get<number>('THROTTLE_LIMIT', 60),
        },
      ],
      inject: [ConfigService],
    }),
    // Drives the hourly oracle submission cycle (OracleSchedulerService).
    ScheduleModule.forRoot(),
    AuthModule,
    UsersModule,
    ProjectsModule,
    SensorsModule,
    CreditsModule,
    OracleModule,
    GovernanceModule,
    AnalyticsModule,
    NotificationsModule,
    StellarModule,
    HealthModule,
    IndexerModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}
