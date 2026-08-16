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
import { GovernanceConfigChange, ConfigChangeStatus } from './entities/governance-config-change.entity';
import { CreateProposalDto } from './dto/create-proposal.dto';
import { VoteDto } from './dto/vote.dto';
import { GovernanceQueryDto } from './dto/governance-query.dto';
import { UpdateGovernanceConfigDto } from './dto/update-governance-config.dto';
import { PendingConfigChangeDto } from './dto/pending-config-change.dto';
import { StellarService } from '../stellar/stellar.service';

// PostgreSQL unique-violation error code
const PG_UNIQUE_VIOLATION = '23505';

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

  async getConfig(): Promise<GovernanceConfig> {
    let config = await this.configRepo.findOne({ where: {} as Record<string, never> });
    if (!config) {
      config = this.configRepo.create({
        protocolFeeBps: 100,
        minOracleConfirmations: 3,
        votingPeriod: 604800,
        timelockPeriod: 86400,
        quorum: 3,
      });
      config = await this.configRepo.save(config);
    }
    return config;
  }

  // ── Config (timelocked write) ─────────────────────────────────────────────
  //
  // Creates a pending config-change record instead of writing to governance_config
  // directly.  A scheduled job (applyDueConfigChanges) commits the values after
  // effectiveAt has passed.

  async proposeConfigChange(
    proposedBy: string,
    dto: UpdateGovernanceConfigDto,
  ): Promise<PendingConfigChangeDto> {
    const { reason, ...rawValues } = dto;

    // Reject empty proposals early.
    const proposedValues = Object.fromEntries(
      Object.entries(rawValues).filter(([, v]) => v !== undefined),
    ) as Partial<Omit<GovernanceConfig, 'id' | 'updatedAt' | 'updatedBy'>>;

    if (Object.keys(proposedValues).length === 0) {
      throw new BadRequestException('No config fields provided');
    }

    const config = await this.getConfig();

    const effectiveAt = new Date(
      Date.now() + config.timelockPeriod * 1_000,
    );

    const change = this.configChangeRepo.create({
      configId: config.id,
      proposedValues,
      proposedBy,
      effectiveAt,
      status: ConfigChangeStatus.PENDING,
      reason: reason ?? null,
    });

    const saved = await this.configChangeRepo.save(change);

    // Write an audit event.
    await this.writeGovernanceEvent('config_change_proposed', proposedBy, {
      changeId: saved.id,
      proposedValues,
      effectiveAt,
    });

    this.logger.log(
      `Config change ${saved.id} proposed by ${proposedBy}, effective at ${effectiveAt.toISOString()}`,
    );

    return PendingConfigChangeDto.fromEntity(saved);
  }

  // ── Pending-change list ───────────────────────────────────────────────────

  async getPendingConfigChanges(): Promise<PendingConfigChangeDto[]> {
    const changes = await this.configChangeRepo.find({
      where: { status: ConfigChangeStatus.PENDING },
      order: { effectiveAt: 'ASC' },
    });
    return changes.map(PendingConfigChangeDto.fromEntity);
  }

  // ── Cancellation ─────────────────────────────────────────────────────────

  async cancelConfigChange(
    changeId: string,
    cancelledBy: string,
  ): Promise<PendingConfigChangeDto> {
    const change = await this.configChangeRepo.findOne({ where: { id: changeId } });

    if (!change) {
      throw new NotFoundException(`Config change ${changeId} not found`);
    }
    if (change.status !== ConfigChangeStatus.PENDING) {
      throw new BadRequestException(
        `Cannot cancel a config change with status '${change.status}'`,
      );
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

  // ── Emergency override ────────────────────────────────────────────────────
  //
  // Bypasses the timelock entirely and writes directly to governance_config.
  // Gated behind SUPER_ADMIN role (enforced in the controller).

  async emergencyConfigUpdate(
    actor: string,
    dto: UpdateGovernanceConfigDto,
  ): Promise<GovernanceConfig> {
    const { reason, ...rawValues } = dto;

    const updates = Object.fromEntries(
      Object.entries(rawValues).filter(([, v]) => v !== undefined),
    ) as Partial<Omit<GovernanceConfig, 'id' | 'updatedAt' | 'updatedBy'>>;

    if (Object.keys(updates).length === 0) {
      throw new BadRequestException('No config fields provided');
    }

    const config = await this.getConfig();

    // Record a corresponding GovernanceConfigChange row for auditability,
    // with status=EMERGENCY and effectiveAt=now.
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

    // Write values directly to the live config row.
    Object.assign(config, updates, { updatedBy: actor });
    const updatedConfig = await this.configRepo.save(config);

    await this.writeGovernanceEvent('config_emergency_updated', actor, {
      changeId: savedChange.id,
      appliedValues: updates,
      reason: reason ?? null,
    });

    this.logger.warn(
      `Emergency config update by ${actor}: ${JSON.stringify(updates)}`,
    );

    return updatedConfig;
  }

  // ── Scheduler: apply due changes ─────────────────────────────────────────
  //
  // Runs every minute.  For each pending change whose effectiveAt <= now, it
  // applies the values to the live governance_config row inside a transaction.
  // Each change is processed individually so a single failure does not block
  // the others.

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
      // Re-fetch inside transaction to guard against concurrent applies.
      const locked = await queryRunner.manager.findOne(GovernanceConfigChange, {
        where: { id: change.id },
        lock: { mode: 'pessimistic_write' },
      });

      if (!locked || locked.status !== ConfigChangeStatus.PENDING) {
        // Another process already handled this change; skip it.
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

      // Apply the proposed values.
      Object.assign(config, locked.proposedValues, { updatedBy: locked.proposedBy });
      await queryRunner.manager.save(GovernanceConfig, config);

      // Mark the change as applied.
      locked.status = ConfigChangeStatus.APPLIED;
      locked.appliedAt = new Date();
      locked.appliedBy = 'scheduler';
      await queryRunner.manager.save(GovernanceConfigChange, locked);

      // Append an audit event inside the same transaction.
      await queryRunner.query(
        `INSERT INTO governance_events (event_type, actor, payload)
         VALUES ($1, $2, $3::jsonb)`,
        [
          'config_change_applied',
          locked.proposedBy,
          JSON.stringify({
            changeId: locked.id,
            appliedValues: locked.proposedValues,
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

  async getProposals(query: GovernanceQueryDto): Promise<{
    data: Proposal[];
    total: number;
    page: number;
    limit: number;
  }> {
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

    qb.orderBy('proposal.created_at', 'DESC');
    qb.skip(query.skip).take(query.limit);

    const [data, total] = await qb.getManyAndCount();
    return { data, total, page: query.page ?? 1, limit: query.limit ?? 20 };
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
    this.logger.log(`Proposal ${saved.id} created by ${proposer}`);
    return saved;
  }

  // ── Vote ─────────────────────────────────────────────────────────────────
  //
  // Correctness invariants:
  //   1. Exactly one vote per (proposal_id, voter_wallet): enforced by the DB
  //      UNIQUE constraint on proposal_votes AND by trying to INSERT inside a
  //      transaction before doing any counter update.
  //   2. Counter update is an atomic SQL INCREMENT (not a read-modify-write),
  //      so concurrent votes on the same proposal cannot lose each other's
  //      counts.
  //   3. The duplicate-check read, the vote INSERT, and the counter increment
  //      all happen inside a single serialisable transaction, so a concurrent
  //      second request from the same wallet will either see the first vote
  //      already committed (fails the findOne check) or hit the unique
  //      constraint (mapped to 409 Conflict).

  async vote(proposalId: string, voter: string, dto: VoteDto): Promise<Proposal> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction('SERIALIZABLE');

    try {
      // 1. Load the proposal inside the transaction so we see a consistent
      //    snapshot (also locks the row against concurrent expiry writes).
      const proposal = await queryRunner.manager.findOne(Proposal, {
        where: { id: proposalId },
        lock: { mode: 'pessimistic_read' },
      });
      if (!proposal) {
        throw new NotFoundException('Proposal not found');
      }

      // Handle expiry inside the same transaction so we never accept a vote on
      // an already-expired proposal.
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

      // 2. Guard: application-layer duplicate check (fast path before the DB
      //    round-trip on insert).  The DB constraint is the definitive guard.
      const existingVote = await queryRunner.manager.findOne(ProposalVote, {
        where: { proposalId, voterWallet: voter },
      });
      if (existingVote) {
        throw new ConflictException('You have already voted on this proposal');
      }

      // 3. Insert the vote record.  If two concurrent transactions both pass
      //    step 2, the unique constraint on (proposal_id, voter_wallet) will
      //    cause one of them to throw a unique-violation, which we translate to
      //    409 Conflict below.
      const voteRecord = queryRunner.manager.create(ProposalVote, {
        proposalId,
        voterWallet: voter,
        support: dto.approve,
      });
      await queryRunner.manager.save(ProposalVote, voteRecord);

      // 4. Atomic counter increment — avoids the stale read-modify-write race
      //    where two concurrent votes both read votesFor=5 and both write 6.
      const counterColumn = dto.approve ? 'votes_for' : 'votes_against';
      await queryRunner.manager
        .createQueryBuilder()
        .update(Proposal)
        .set({ [counterColumn]: () => `${counterColumn} + 1` })
        .where('id = :id', { id: proposalId })
        .execute();

      // 5. Reload the proposal to get the authoritative counter values so we
      //    can evaluate quorum.  This reload is inside the same transaction, so
      //    it sees the increment we just applied.
      const updated = await queryRunner.manager.findOne(Proposal, {
        where: { id: proposalId },
      });
      if (!updated) {
        throw new InternalServerErrorException('Proposal disappeared mid-transaction');
      }

      // 6. Quorum check — cast bigint columns to Number for arithmetic.
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

      this.logger.log(
        `Vote cast on proposal ${proposalId} by ${voter}: ${dto.approve ? 'for' : 'against'}`,
      );

      return updated;
    } catch (err) {
      await queryRunner.rollbackTransaction();

      // Map Postgres unique-violation (race-condition path) to 409 Conflict so
      // the second concurrent vote gets a clean, retryable error rather than a
      // 500.
      if (
        err instanceof QueryFailedError &&
        (err as QueryFailedError & { code?: string }).code === PG_UNIQUE_VIOLATION
      ) {
        throw new ConflictException('You have already voted on this proposal');
      }

      // Re-throw NestJS HTTP exceptions directly.
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

  // ── Execute ───────────────────────────────────────────────────────────────
  //
  // Contract for callers:
  //   • Returns the updated Proposal with status=EXECUTED only after the
  //     Soroban transaction is confirmed.
  //   • If the Soroban call throws for any reason (RPC error, tx failure,
  //     timeout) the local status remains PASSED and the error propagates so
  //     the caller can retry.

  async executeProposal(proposalId: string, executor: string): Promise<Proposal> {
    const proposal = await this.getProposalById(proposalId);

    if (proposal.status !== ProposalStatus.PASSED) {
      throw new BadRequestException('Proposal has not passed');
    }

    // Timelock: measure elapsed from the voting deadline (the earliest point
    // the proposal could have passed), not from local server time of the
    // createProposal call, to prevent clock-skew games.
    const config = await this.getConfig();
    const elapsed = Date.now() - new Date(proposal.deadline).getTime();
    const timelockMs = config.timelockPeriod * 1000;

    if (elapsed < timelockMs) {
      throw new ForbiddenException(
        `Timelock not elapsed. Wait ${Math.ceil((timelockMs - elapsed) / 1000)} more seconds`,
      );
    }

    // Resolve the Soroban governance contract ID from config.
    const governanceContractId = this.configService.get<string>('stellar.contractGovernance', '');
    if (!governanceContractId) {
      throw new InternalServerErrorException(
        'Governance contract ID is not configured (stellar.contractGovernance)',
      );
    }

    // onChainProposalId must be set before execution.  In the current flow
    // proposals are created off-chain only, so we derive a deterministic u32
    // from the DB row's auto-incrementing numeric sequence.  If the proposal
    // was created on-chain in the future, this field would be populated at
    // proposal creation time instead.
    if (proposal.onChainProposalId === null || proposal.onChainProposalId === undefined) {
      throw new BadRequestException(
        'Proposal does not have an on-chain ID. Set onChainProposalId before executing.',
      );
    }

    // ── Call Soroban BEFORE updating local state ──────────────────────────
    // Local status is updated only after confirmation so that a failed RPC
    // call leaves the proposal in PASSED and allows retries.
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
      // Do NOT update local status — leave as PASSED so the admin can retry.
      throw new InternalServerErrorException(
        `On-chain execution failed: ${(err as Error).message}`,
      );
    }

    // ── Persist confirmed execution ───────────────────────────────────────
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

  /**
   * Appends a row to the governance_events table.
   * Uses raw SQL so it works both inside and outside transactions.
   */
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
      // Event writes are best-effort — never let them fail a business operation.
      this.logger.warn(
        `Failed to write governance event '${eventType}': ${(err as Error).message}`,
      );
    }
  }
}
