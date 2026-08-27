import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bull';
import { OracleController } from './oracle.controller';
import { OracleService } from './oracle.service';
import { OracleProcessor } from './oracle-processor';
import { OracleSchedulerService } from './oracle-scheduler.service';
import { CreditScoringService } from './credit-scoring.service';
import { OracleSubmission } from './entities/oracle-submission.entity';
import { OracleScheduleState } from './entities/oracle-schedule-state.entity';
import { GovernanceConfig } from '../governance/entities/governance-config.entity';
import { SensorReading } from '../sensors/entities/sensor-reading.entity';
import { Project } from '../projects/entities/project.entity';
import { ReadingBatch } from '../sensors/entities/reading-batch.entity';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [
    // GovernanceConfig is needed by OracleProcessor to snapshot config at
    // batch-start (Issue #34).  GovernanceModule also registers it; TypeORM
    // deduplicates the underlying repository provider.
    // Project and ReadingBatch are needed by OracleProcessor to calculate
    // and assign credits once a submission is confirmed on-chain, and by
    // OracleSchedulerService to select which batches are due for submission.
    // The @Cron handler itself is discovered by ScheduleModule.forRoot(),
    // registered globally in AppModule.
    TypeOrmModule.forFeature([
      OracleSubmission,
      GovernanceConfig,
      SensorReading,
      Project,
      ReadingBatch,
      OracleScheduleState,
    ]),
    BullModule.registerQueue({
      name: 'oracle-submit',
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: 'fixed',
          delay: 10000,
        },
        removeOnComplete: 50,
      },
    }),
    NotificationsModule,
  ],
  controllers: [OracleController],
  providers: [OracleService, OracleProcessor, CreditScoringService, OracleSchedulerService],
  exports: [OracleService, OracleSchedulerService, TypeOrmModule],
})
export class OracleModule {}
