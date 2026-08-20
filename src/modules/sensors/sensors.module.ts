import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bull';
import { SensorsController } from './sensors.controller';
import { SensorsService } from './sensors.service';
import { SensorsGateway } from './sensors.gateway';
import { SensorsIngestionProcessor } from './sensors-ingestion.processor';
import { SensorDevice } from './entities/sensor-device.entity';
import { SensorReading } from './entities/sensor-reading.entity';
import { ReadingBatch } from './entities/reading-batch.entity';
import { GovernanceConfig } from '../governance/entities/governance-config.entity';
import { ApiKeyGuard } from '../../common/guards/api-key.guard';
import { AuthModule } from '../auth/auth.module';
import { ProjectsModule } from '../projects/projects.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([SensorDevice, SensorReading, ReadingBatch, GovernanceConfig]),
    AuthModule,
    ProjectsModule,
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
  providers: [SensorsService, SensorsGateway, SensorsIngestionProcessor, ApiKeyGuard],
  exports: [SensorsService, SensorsGateway, TypeOrmModule],
})
export class SensorsModule {}
