import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bull';
import { SensorsController } from './sensors.controller';
import { SensorsService } from './sensors.service';
import { SensorsGateway } from './sensors.gateway';
import { SensorProjectAccessService } from './sensor-project-access.service';
import { SensorsIngestionProcessor } from './sensors-ingestion.processor';
import { SensorAlertDebounceService } from './sensor-alert-debounce.service';
import { SensorAlertRecipientsService } from './sensor-alert-recipients.service';
import { SensorStalenessSchedulerService } from './sensor-staleness-scheduler.service';
import { SensorDevice } from './entities/sensor-device.entity';
import { SensorReading } from './entities/sensor-reading.entity';
import { ReadingBatch } from './entities/reading-batch.entity';
import { GovernanceConfig } from '../governance/entities/governance-config.entity';
import { ApiKeyGuard } from '../../common/guards/api-key.guard';
import { AuthModule } from '../auth/auth.module';
import { ProjectsModule } from '../projects/projects.module';
import { UsersModule } from '../users/users.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([SensorDevice, SensorReading, ReadingBatch, GovernanceConfig]),
    AuthModule,
    ProjectsModule,
    UsersModule,
    NotificationsModule,
    BullModule.registerQueue({
      name: 'sensor-ingestion',
      defaultJobOptions: {
        attempts: 5,
        backoff: {
          type: 'exponential',
          delay: 1000,
        },
      },
    }),
  ],
  controllers: [SensorsController],
  providers: [
    SensorsService,
    SensorsGateway,
    SensorProjectAccessService,
    SensorsIngestionProcessor,
    SensorAlertDebounceService,
    SensorAlertRecipientsService,
    SensorStalenessSchedulerService,
    ApiKeyGuard,
  ],
  exports: [SensorsService, SensorsGateway, TypeOrmModule],
})
export class SensorsModule {}
