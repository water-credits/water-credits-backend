import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bull';
import { OracleController } from './oracle.controller';
import { OracleService } from './oracle.service';
import { OracleProcessor } from './oracle-processor';
import { OracleSubmission } from './entities/oracle-submission.entity';
import { CreditScoringService } from './credit-scoring.service';
import { GovernanceConfig } from '../governance/entities/governance-config.entity';
import { Project } from '../projects/entities/project.entity';
import { ReadingBatch } from '../sensors/entities/reading-batch.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([OracleSubmission, GovernanceConfig, Project, ReadingBatch]),
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
  ],
  controllers: [OracleController],
  providers: [OracleService, OracleProcessor, CreditScoringService],
  exports: [OracleService, TypeOrmModule],
})
export class OracleModule {}
