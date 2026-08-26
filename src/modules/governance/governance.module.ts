import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { GovernanceController } from './governance.controller';
import { GovernanceService } from './governance.service';
import { Proposal } from './entities/proposal.entity';
import { ProposalVote } from './entities/proposal-vote.entity';
import { GovernanceConfig } from './entities/governance-config.entity';
import { GovernanceConfigChange } from './entities/governance-config-change.entity';
import { StellarModule } from '../stellar/stellar.module';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Proposal, ProposalVote, GovernanceConfig, GovernanceConfigChange]),
    // ScheduleModule enables @Cron decorators inside GovernanceService.
    // forRoot() is idempotent — calling it in a child module alongside
    // app.module.ts is safe.
    ScheduleModule.forRoot(),
    // StellarModule is @Global() but we import it explicitly here so the
    // dependency is visible in the module graph and to avoid relying on
    // implicit global resolution.
    StellarModule,
    // UsersModule exports UsersService, used to count eligible voters for the
    // percentage-based quorum. No cycle: UsersModule does not depend on
    // GovernanceModule.
    UsersModule,
  ],
  controllers: [GovernanceController],
  providers: [GovernanceService],
  exports: [GovernanceService, TypeOrmModule],
})
export class GovernanceModule {}
