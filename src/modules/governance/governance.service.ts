import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  InternalServerErrorException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, QueryFailedError, LessThanOrEqual } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Proposal, ProposalStatus } from './entities/proposal.entity';
import { ProposalVote } from './entities/proposal-vote.entity';
import { GovernanceConfig } from './entities/governance-config.entity';
import {
  GovernanceConfigChange,
  ConfigChangeStatus,
} from './entities/governance-config-change.entity';
import { CreateProposalDto } from './dto/create-proposal.dto';
import { VoteDto } from './dto/vote.dto';
import { GovernanceQueryDto } from './dto/governance-query.dto';
import {
  UpdateGovernanceConfigDto,
  assertWeightsSum,
  computeEffectiveWeights,
  validateWeightsSum,
  WEIGHT_SUM_TOLERANCE,
} from './dto/update-governance-config.dto';
import { PendingConfigChangeDto } from './dto/pending-config-change.dto';
import { StellarService } from '../stellar/stellar.service';
import { paginate, PaginatedList } from '../../common/pagination';

const PG_UNIQUE_VIOLATION = '23505';

const MUTABLE_CONFIG_FIELDS = [
  'protocolFeeBps',
  'minOracleConfirmations',
  'votingPeriod',
  'timelockPeriod',
  'quorum',
  'phMin',
  'phMax',
  'doThreshold',
  'tempPenaltyDelta',
  'weightVolumetric',
  'weightNitrogen',
  'weightPhosphorus',
] as const;

type MutableConfigField = (typeof MUTABLE_CONFIG_FIELDS)[number];

export interface FieldDiff {
  field: MutableConfigField;
  oldValue: unknown;
  newValue: unknown;
}

function computeFieldDiffs(
  oldCfg: GovernanceConfig,
  updates: Partial<Pick<GovernanceConfig, MutableConfigField>>,
): FieldDiff[] {
  const diffs: FieldDiff[] = [];
  for (const field of MUTABLE_CONFIG_FIELDS) {
    if (updates[field] === undefined) {
      continue;
    }
    const oldValue = oldCfg[field];
    const newValue = updates[field];
    if (oldValue === newValue) {
      continue;
    }
    diffs.push({ field, oldValue: oldValue ?? null, newValue: newValue ?? null });
  }
  return diffs;
}

function applyMutableUpdates(
  config: GovernanceConfig,
  updates: Partial<Pick<GovernanceConfig, MutableConfigField>>,
): void {
  for (const field of MUTABLE_CONFIG_FIELDS) {
    const value = updates[field];
    if (value === undefined) {
      continue;
    }
    (config as unknown as Record<MutableConfigField, unknown>)[field] = value;
  }
}

function extractMutableUpdates(
  dto: UpdateGovernanceConfigDto,
): Partial<Pick<GovernanceConfig, MutableConfigField>> {
  const result: Partial<Pick<GovernanceConfig, MutableConfigField>> = {};
  for (const key of MUTABLE_CONFIG_FIELDS) {
    if (key in dto && (dto as unknown as Record<string, unknown>)[key] !== undefined) {
      (result as unknown as Record<string, unknown>)[key] = (
        dto as unknown as Record<string, unknown>
      )[key];
    }
  }
  return result;
}

@Injectable()
export class GovernanceService {
  private readonly logger = new Logger(GovernanceService.name);

  constructor(
    @InjectRepository(Proposal)
    private readonly proposalRepo: Repository<Proposal>,
    @InjectRepository(ProposalVote)
    private readonly voteRepo: Repository<ProposalVote>,
    @InjectRepository(GovernanceConfig)
    private readonly configRepo: Repository<GovernanceConfig>,
    @InjectRepository(GovernanceConfigChange)
    private readonly configChangeRepo: Repository<GovernanceConfigChange>,
    private readonly configService: ConfigService,
    private readonly dataSource: DataSource,
    private readonly stellarService: StellarService,
  ) {}

  // ── Config (read) ─────────────────────────────────────────────────────────
  //
  // governance_config is a singleton: row id = 1 is the only row that can ever
  // exist (enforced by a CHECK(id = 1) constraint alongside the primary key —
  // see the GovernanceConfig entity and migration
  // 016_governance_config_singleton.sql). Querying by that fixed id, rather
  // than an unfiltered findOne(), makes getConfig() deterministic even if
  // duplicate rows somehow existed.
  //
  // Auto-provisioning on cold start (no row yet) is race-safe: if two
  // requests both miss the SELECT below, both attempt the INSERT, and
  // ON CONFLICT DO NOTHING lets the loser silently no-op instead of throwing
  // — the DB constraint guarantees only one of them actually creates the row.

  async getConfig(): Promise<GovernanceConfig> {
    const existing = await this.configRepo.findOne({ where: { id: 1 } });
    if (existing) {
      return existing;
    }

    await this.configRepo
      .createQueryBuilder()
      .insert()
      .into(GovernanceConfig)
      .values({
        id: 1,
        protocolFeeBps: 100,
        minOracleConfirmations: 3,
        votingPeriod: 604800,
        timelockPeriod: 86400,
        quorum: 3,
      })
      .orIgnore()
      .execute();

    const config = await this.configRepo.findOne({ where: { id: 1 } });
    if (!config) {
      throw new InternalServerErrorException('Governance config singleton row is missing');
    }
    return config;
  }

  async proposeConfigChange(
    proposedBy: string,
    dto: UpdateGovernanceConfigDto,
  ): Promise<PendingConfigChangeDto> {
    const { reason } = dto;
    const updates = extractMutableUpdates(dto);

    if (Object.keys(updates).length === 0) {
      throw new BadRequestException('No config fields provided');
    }

    const config = await this.getConfig();
    assertWeightsSum(config, updates);

    const projectedDiffs = computeFieldDiffs(config, updates);

    const effectiveAt = new Date(Date.now() + config.timelockPeriod * 1_000);

    const change = this.configChangeRepo.create({
      configId: config.id,
      proposedValues: updates,
      proposedBy,
      effectiveAt,
      status: ConfigChangeStatus.PENDING,
      reason: reason ?? null,
    });
    const saved = await this.configChangeRepo.save(change);

    await this.writeGovernanceEvent('config_change_proposed', proposedBy, {
      changeId: saved.id,
      proposedValues: updates,
      projectedDiffs,
      effectiveAt,
    });

    this.logger.log(
      `Config change ${saved.id} proposed by ${proposedBy}, effective at ${effectiveAt.toISOString()}`,
    );

    return PendingConfigChangeDto.fromEntity(saved);
  }

  async getPendingConfigChanges(): Promise<PendingConfigChangeDto[]> {
    const changes = await this.configChangeRepo.find({
      where: { status: ConfigChangeStatus.PENDING },
      order: { effectiveAt: 'ASC' },
    });
    return changes.map(PendingConfigChangeDto.fromEntity);
  }

  async cancelConfigChange(changeId: string, cancelledBy: string): Promise<PendingConfigChangeDto> {
    const change = await this.configChangeRepo.findOne({ where: { id: changeId } });

    if (!change) {
      throw new NotFoundException(`Config change ${changeId} not found`);
    }
    if (change.status !== ConfigChangeStatus.PENDING) {
      throw new BadRequestException(`Cannot cancel a config change with status '${change.status}'`);
    }

    change.status = ConfigChangeStatus.CANCELLED;
    change.cancelledAt = new Date();
    change.cancelledBy = cancelledBy;

    const saved = await this.configChangeRepo.save(change);

    await this.writeGovernanceEvent('config_change_cancelled', cancelledBy, {
      changeId: saved.id,
      proposedValues: saved.proposedValues,
    });

    this.logger.log(`Config change ${changeId} cancelled by ${cancelledBy}`);

    return PendingConfigChangeDto.fromEntity(saved);
  }

  async emergencyConfigUpdate(
    actor: string,
    dto: UpdateGovernanceConfigDto,
  ): Promise<GovernanceConfig> {
    const { reason } = dto;
    const updates = extractMutableUpdates(dto);

    if (Object.keys(updates).length === 0) {
      throw new BadRequestException('No config fields provided');
    }

    const config = await this.getConfig();
    assertWeightsSum(config, updates);

    const diffs = computeFieldDiffs(config, updates);
    if (diffs.length === 0) {
      throw new BadRequestException('No config values changed');
    }

    const changeRecord = this.configChangeRepo.create({
      configId: config.id,
      proposedValues: updates,
      proposedBy: actor,
      effectiveAt: new Date(),
      status: ConfigChangeStatus.EMERGENCY,
      appliedAt: new Date(),
      appliedBy: actor,
      reason: reason ?? null,
    });
    const savedChange = await this.configChangeRepo.save(changeRecord);

    applyMutableUpdates(config, updates);
    config.updatedBy = actor;
    const updatedConfig = await this.configRepo.save(config);

    await this.writeGovernanceEvent('config_emergency_updated', actor, {
      changeId: savedChange.id,
      diffs,
      appliedValues: updates,
      reason: reason ?? null,
    });

    await this.writeGovernanceEvent('config_updated', actor, {
      changeId: savedChange.id,
      diffs,
      oldValues: Object.fromEntries(diffs.map((d) => [d.field, d.oldValue])),
      newValues: Object.fromEntries(diffs.map((d) => [d.field, d.newValue])),
      emergency: true,
      reason: reason ?? null,
    });

    this.logger.warn(`Emergency config update by ${actor}: ${JSON.stringify(updates)}`);

    return updatedConfig;
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async applyDueConfigChanges(): Promise<void> {
    const due = await this.configChangeRepo.find({
      where: {
        status: ConfigChangeStatus.PENDING,
        effectiveAt: LessThanOrEqual(new Date()),
      },
      order: { effectiveAt: 'ASC' },
    });

    if (due.length === 0) {
      return;
    }

    this.logger.log(`Applying ${due.length} due config change(s)`);

    for (const change of due) {
      await this.applySingleChange(change);
    }
  }

  private async applySingleChange(change: GovernanceConfigChange): Promise<void> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const locked = await queryRunner.manager.findOne(GovernanceConfigChange, {
        where: { id: change.id },
        lock: { mode: 'pessimistic_write' },
      });

      if (!locked || locked.status !== ConfigChangeStatus.PENDING) {
        await queryRunner.rollbackTransaction();
        return;
      }

      const config = await queryRunner.manager.findOne(GovernanceConfig, {
        where: { id: locked.configId },
      });

      if (!config) {
        this.logger.error(`Config row ${locked.configId} not found for change ${locked.id}`);
        await queryRunner.rollbackTransaction();
        return;
      }

      const updates = locked.proposedValues as Partial<Pick<GovernanceConfig, MutableConfigField>>;

      const hasWeightUpdate =
        updates.weightVolumetric !== undefined ||
        updates.weightNitrogen !== undefined ||
        updates.weightPhosphorus !== undefined;
      if (hasWeightUpdate) {
        const effective = computeEffectiveWeights(
          {
            weightVolumetric: Number(config.weightVolumetric),
            weightNitrogen: Number(config.weightNitrogen),
            weightPhosphorus: Number(config.weightPhosphorus),
          },
          {
            weightVolumetric:
              updates.weightVolumetric !== undefined ? Number(updates.weightVolumetric) : undefined,
            weightNitrogen:
              updates.weightNitrogen !== undefined ? Number(updates.weightNitrogen) : undefined,
            weightPhosphorus:
              updates.weightPhosphorus !== undefined ? Number(updates.weightPhosphorus) : undefined,
          },
        );
        const check = validateWeightsSum(effective, WEIGHT_SUM_TOLERANCE);
        if (!check.ok) {
          this.logger.error(`Refusing to apply config change ${locked.id}: ${check.message}`);
          locked.status = ConfigChangeStatus.CANCELLED;
          locked.cancelledAt = new Date();
          locked.cancelledBy = 'scheduler';
          await queryRunner.manager.save(GovernanceConfigChange, locked);
          await queryRunner.commitTransaction();
          return;
        }
      }

      const diffs = computeFieldDiffs(config, updates);

      applyMutableUpdates(config, updates);
      config.updatedBy = locked.proposedBy;
      await queryRunner.manager.save(GovernanceConfig, config);

      locked.status = ConfigChangeStatus.APPLIED;
      locked.appliedAt = new Date();
      locked.appliedBy = 'scheduler';
      await queryRunner.manager.save(GovernanceConfigChange, locked);

      await queryRunner.query(
        `INSERT INTO governance_events (event_type, actor, payload)
         VALUES ($1, $2, $3::jsonb)`,
        [
          'config_change_applied',
          locked.proposedBy,
          JSON.stringify({
            changeId: locked.id,
            appliedValues: locked.proposedValues,
            diffs,
          }),
        ],
      );

      await queryRunner.query(
        `INSERT INTO governance_events (event_type, actor, payload)
         VALUES ($1, $2, $3::jsonb)`,
        [
          'config_updated',
          locked.proposedBy,
          JSON.stringify({
            changeId: locked.id,
            diffs,
            oldValues: Object.fromEntries(diffs.map((d) => [d.field, d.oldValue])),
            newValues: Object.fromEntries(diffs.map((d) => [d.field, d.newValue])),
          }),
        ],
      );

      await queryRunner.commitTransaction();

      this.logger.log(`Config change ${locked.id} applied (proposed by ${locked.proposedBy})`);
    } catch (err) {
      await queryRunner.rollbackTransaction();
      this.logger.error(
        `Failed to apply config change ${change.id}: ${(err as Error).message}`,
        (err as Error).stack,
      );
    } finally {
      await queryRunner.release();
    }
  }

  // ── Proposals ─────────────────────────────────────────────────────────────

  async getProposals(query: GovernanceQueryDto): Promise<PaginatedList<Proposal>> {
    const qb = this.proposalRepo.createQueryBuilder('proposal');

    if (query.status) {
      qb.andWhere('proposal.status = :status', { status: query.status });
    }
    if (query.proposer) {
      qb.andWhere('proposal.proposer = :proposer', { proposer: query.proposer });
    }
    if (query.actionType) {
      qb.andWhere('proposal.action_type = :actionType', { actionType: query.actionType });
    }

    return paginate(
      qb,
      { alias: 'proposal', sortColumn: 'proposal.created_at', sortProperty: 'createdAt' },
      query,
    );
  }

  async getProposalById(id: string): Promise<Proposal> {
    const proposal = await this.proposalRepo.findOne({ where: { id } });
    if (!proposal) {
      throw new NotFoundException('Proposal not found');
    }
    await this.checkExpiry(proposal);
    return proposal;
  }

  async createProposal(proposer: string, dto: CreateProposalDto): Promise<Proposal> {
    const config = await this.getConfig();

    const deadline = new Date();
    deadline.setSeconds(deadline.getSeconds() + config.votingPeriod);

    const proposal = this.proposalRepo.create({
      proposer,
      title: dto.title,
      description: dto.description ?? null,
      actionType: dto.actionType,
      actionParams: (dto.actionParams as Record<string, unknown>) ?? null,
      votesFor: 0,
      votesAgainst: 0,
      status: ProposalStatus.ACTIVE,
      deadline,
    });

    const saved = await this.proposalRepo.save(proposal);

    await this.writeGovernanceEvent('proposal_created', proposer, {
      proposalId: saved.id,
      title: saved.title,
      deadline,
    });

    this.logger.log(`Proposal ${saved.id} created by ${proposer}`);
    return saved;
  }

  async vote(proposalId: string, voter: string, dto: VoteDto): Promise<Proposal> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction('SERIALIZABLE');

    try {
      const proposal = await queryRunner.manager.findOne(Proposal, {
        where: { id: proposalId },
        lock: { mode: 'pessimistic_read' },
      });
      if (!proposal) {
        throw new NotFoundException('Proposal not found');
      }

      if (proposal.status === ProposalStatus.ACTIVE && new Date() > new Date(proposal.deadline)) {
        await queryRunner.manager
          .createQueryBuilder()
          .update(Proposal)
          .set({ status: ProposalStatus.EXPIRED })
          .where('id = :id', { id: proposalId })
          .execute();
        proposal.status = ProposalStatus.EXPIRED;
      }

      if (proposal.status !== ProposalStatus.ACTIVE) {
        throw new BadRequestException('Proposal is not active');
      }

      const existingVote = await queryRunner.manager.findOne(ProposalVote, {
        where: { proposalId, voterWallet: voter },
      });
      if (existingVote) {
        throw new ConflictException('You have already voted on this proposal');
      }

      const voteRecord = queryRunner.manager.create(ProposalVote, {
        proposalId,
        voterWallet: voter,
        support: dto.approve,
      });
      await queryRunner.manager.save(ProposalVote, voteRecord);

      const counterColumn = dto.approve ? 'votes_for' : 'votes_against';
      await queryRunner.manager
        .createQueryBuilder()
        .update(Proposal)
        .set({ [counterColumn]: () => `${counterColumn} + 1` })
        .where('id = :id', { id: proposalId })
        .execute();

      const updated = await queryRunner.manager.findOne(Proposal, {
        where: { id: proposalId },
      });
      if (!updated) {
        throw new InternalServerErrorException('Proposal disappeared mid-transaction');
      }

      const config = await this.getConfig();
      const votesFor = Number(updated.votesFor);
      const votesAgainst = Number(updated.votesAgainst);
      const totalVotes = votesFor + votesAgainst;

      if (totalVotes >= config.quorum) {
        const newStatus = votesFor > votesAgainst ? ProposalStatus.PASSED : ProposalStatus.REJECTED;

        await queryRunner.manager
          .createQueryBuilder()
          .update(Proposal)
          .set({ status: newStatus })
          .where('id = :id', { id: proposalId })
          .execute();

        updated.status = newStatus;
      }

      await queryRunner.commitTransaction();

      await this.writeGovernanceEvent('vote_cast', voter, {
        proposalId,
        approve: dto.approve,
      });

      this.logger.log(
        `Vote cast on proposal ${proposalId} by ${voter}: ${dto.approve ? 'for' : 'against'}`,
      );

      return updated;
    } catch (err) {
      await queryRunner.rollbackTransaction();

      if (
        err instanceof QueryFailedError &&
        (err as QueryFailedError & { code?: string }).code === PG_UNIQUE_VIOLATION
      ) {
        throw new ConflictException('You have already voted on this proposal');
      }

      if (
        err instanceof NotFoundException ||
        err instanceof BadRequestException ||
        err instanceof ConflictException ||
        err instanceof ForbiddenException ||
        err instanceof InternalServerErrorException
      ) {
        throw err;
      }

      this.logger.error(`Vote transaction failed for proposal ${proposalId}`, err);
      throw new InternalServerErrorException('Vote could not be recorded');
    } finally {
      await queryRunner.release();
    }
  }

  async executeProposal(proposalId: string, executor: string): Promise<Proposal> {
    const proposal = await this.getProposalById(proposalId);

    if (proposal.status !== ProposalStatus.PASSED) {
      throw new BadRequestException('Proposal has not passed');
    }

    const config = await this.getConfig();
    const elapsed = Date.now() - new Date(proposal.deadline).getTime();
    const timelockMs = config.timelockPeriod * 1000;

    if (elapsed < timelockMs) {
      throw new ForbiddenException(
        `Timelock not elapsed. Wait ${Math.ceil((timelockMs - elapsed) / 1000)} more seconds`,
      );
    }

    const governanceContractId = this.configService.get<string>('stellar.contractGovernance', '');
    if (!governanceContractId) {
      throw new InternalServerErrorException(
        'Governance contract ID is not configured (stellar.contractGovernance)',
      );
    }

    if (proposal.onChainProposalId === null || proposal.onChainProposalId === undefined) {
      throw new BadRequestException(
        'Proposal does not have an on-chain ID. Set onChainProposalId before executing.',
      );
    }

    let txHash: string;
    try {
      const result = await this.stellarService.execute(
        governanceContractId,
        proposal.onChainProposalId,
      );

      txHash =
        (result as { txHash?: string } | null)?.txHash ??
        (result as { hash?: string } | null)?.hash ??
        'confirmed';
    } catch (err) {
      this.logger.error(
        `Soroban execute() failed for proposal ${proposalId}: ${(err as Error).message}`,
        (err as Error).stack,
      );
      throw new InternalServerErrorException(
        `On-chain execution failed: ${(err as Error).message}`,
      );
    }

    await this.proposalRepo
      .createQueryBuilder()
      .update(Proposal)
      .set({
        status: ProposalStatus.EXECUTED,
        executionTxHash: txHash,
        executedBy: executor,
        executedAt: new Date(),
      })
      .where('id = :id', { id: proposalId })
      .execute();

    const saved = await this.proposalRepo.findOne({ where: { id: proposalId } });
    if (!saved) {
      throw new InternalServerErrorException('Proposal not found after execution update');
    }

    await this.writeGovernanceEvent('proposal_executed', executor, {
      proposalId,
      txHash,
    });

    this.logger.log(`Proposal ${proposalId} executed on-chain by ${executor} (txHash: ${txHash})`);
    return saved;
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private async checkExpiry(proposal: Proposal): Promise<void> {
    if (proposal.status !== ProposalStatus.ACTIVE) {
      return;
    }
    if (new Date() > new Date(proposal.deadline)) {
      const result = await this.proposalRepo
        .createQueryBuilder()
        .update(Proposal)
        .set({ status: ProposalStatus.EXPIRED })
        .where('id = :id', { id: proposal.id })
        .andWhere('status = :active', { active: ProposalStatus.ACTIVE })
        .execute();

      if (result.affected) {
        proposal.status = ProposalStatus.EXPIRED;
      }
    }
  }

  private async writeGovernanceEvent(
    eventType: string,
    actor: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.dataSource.query(
        `INSERT INTO governance_events (event_type, actor, payload)
         VALUES ($1, $2, $3::jsonb)`,
        [eventType, actor, JSON.stringify(payload)],
      );
    } catch (err) {
      this.logger.warn(
        `Failed to write governance event '${eventType}': ${(err as Error).message}`,
      );
    }
  }
}
