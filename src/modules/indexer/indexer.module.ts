import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IndexerService } from './indexer.service';
import { IndexerCursor } from './entities/indexer-cursor.entity';
import { OracleSubmission } from '../oracle/entities/oracle-submission.entity';
import { ReadingBatch } from '../sensors/entities/reading-batch.entity';
import { Retirement } from '../credits/entities/retirement.entity';
import { Proposal } from '../governance/entities/proposal.entity';
import { NotificationsModule } from '../notifications/notifications.module';
import { SensorsModule } from '../sensors/sensors.module';

/**
 * IndexerModule — registers the long-running Soroban event-polling service.
 *
 * Imports:
 *   - TypeOrmModule.forFeature: the entities this service reads/writes.
 *   - NotificationsModule: provides NotificationsService + NotificationsGateway.
 *   - SensorsModule: provides SensorsGateway for real-time broadcasts.
 *
 * StellarModule and ConfigModule are global — no explicit import needed.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      IndexerCursor,
      OracleSubmission,
      ReadingBatch,
      Retirement,
      Proposal,
    ]),
    NotificationsModule,
    SensorsModule,
  ],
  providers: [IndexerService],
  exports: [IndexerService],
})
export class IndexerModule {}
