import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';
import { StellarModule } from '../stellar/stellar.module';
import { OracleScheduleState } from '../oracle/entities/oracle-schedule-state.entity';

@Module({
  // OracleScheduleState backs the oracle-freshness section of the report; the
  // OracleModule registers the same entity and TypeORM deduplicates the
  // underlying repository provider.
  imports: [TypeOrmModule.forFeature([OracleScheduleState]), StellarModule],
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
