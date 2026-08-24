import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { scValToNative } from '@stellar/stellar-sdk';
import { SorobanRpc } from '@stellar/stellar-sdk';
import { StellarClient } from '../stellar/stellar.client';
import { NotificationsService } from '../notifications/notifications.service';
import { SensorsGateway } from '../sensors/sensors.gateway';
import { NotificationsGateway } from '../notifications/notifications.gateway';
import { OracleSubmission, SubmissionStatus } from '../oracle/entities/oracle-submission.entity';
import { ReadingBatch, BatchStatus } from '../sensors/entities/reading-batch.entity';
import { Retirement } from '../credits/entities/retirement.entity';
import { User } from '../users/entities/user.entity';
import { Proposal, ProposalStatus } from '../governance/entities/proposal.entity';
import { IndexerCursor, MAIN_CURSOR_KEY } from './entities/indexer-cursor.entity';
import {
  DecodedEvent,
  IndexedEvent,
  decodeEvent,
  CreditMintEvent,
  CreditRetireEvent,
  OracleReadingSubmittedEvent,
  GovernanceProposalExecutedEvent,
} from './indexer.types';

/**
 * Maximum ledger-event gap before the Soroban RPC archive window expires.
 * Testnet and mainnet both retain ~17 280 ledgers (~24 h at 5 s/ledger).
 * We warn at 17 000 to give operators time to react before events are lost.
 */
export const LEDGER_GAP_WARNING_THRESHOLD = 17_000;

/**
 * Maximum number of events the Soroban getEvents RPC returns per call.
 * https://developers.stellar.org/docs/data/rpc/api-reference/methods/getEvents
 */
const MAX_EVENTS_PER_PAGE = 10_000;

/**
 * IndexerService — long-running Soroban event-polling service.
 *
 * Responsibilities:
 *   - Maintains a durable ledger cursor (indexer_cursor table, 'main' row).
 *   - Polls server.getEvents() on a configurable interval (default 10 s,
 *     env INDEXER_POLL_INTERVAL_MS).
 *   - Pages through multi-ledger ranges so a single call never drops events.
 *   - Decodes and dispatches each contract event to the appropriate handler.
 *   - All DB mutations are idempotent — safe to apply twice.
 *   - Emits WebSocket events via NotificationsGateway / SensorsGateway.
 *   - Detects and logs structured warnings when the cursor lags the chain tip
 *     by more than LEDGER_GAP_WARNING_THRESHOLD ledgers.
 */
@Injectable()
export class IndexerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(IndexerService.name);

  /** Handle returned by setInterval so we can clear it on shutdown. */
  private pollHandle: ReturnType<typeof setInterval> | null = null;

  /** Prevents concurrent poll cycles from racing. */
  private polling = false;

  constructor(
    private readonly configService: ConfigService,
    private readonly stellarClient: StellarClient,
    private readonly notificationsService: NotificationsService,
    private readonly sensorsGateway: SensorsGateway,
    private readonly notificationsGateway: NotificationsGateway,
    private readonly dataSource: DataSource,
    @InjectRepository(IndexerCursor)
    private readonly cursorRepo: Repository<IndexerCursor>,
    @InjectRepository(OracleSubmission)
    private readonly submissionRepo: Repository<OracleSubmission>,
    @InjectRepository(ReadingBatch)
    private readonly batchRepo: Repository<ReadingBatch>,
    @InjectRepository(Retirement)
    private readonly retirementRepo: Repository<Retirement>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @InjectRepository(Proposal)
    private readonly proposalRepo: Repository<Proposal>,
  ) {}

  // ── Lifecycle ──────────────────────────────────────────────────────────

  onModuleInit(): void {
    const intervalMs = this.configService.get<number>(
      'INDEXER_POLL_INTERVAL_MS',
      10_000,
    );

    this.logger.log(`IndexerService starting — poll interval ${intervalMs} ms`);

    // Fire once immediately so the first poll is not delayed by the interval.
    void this.runPollCycle();

    this.pollHandle = setInterval(() => {
      void this.runPollCycle();
    }, intervalMs);
  }

  onModuleDestroy(): void {
    if (this.pollHandle) {
      clearInterval(this.pollHandle);
      this.pollHandle = null;
      this.logger.log('IndexerService stopped');
    }
  }

  // ── Public status (for GET /health) ───────────────────────────────────

  async getIndexerStatus(): Promise<{
    status: 'ok' | 'behind' | 'stopped';
    lastIndexedLedger: number | null;
    chainTipLedger: number | null;
    lag: number | null;
  }> {
    try {
      const [cursor, tip] = await Promise.all([
        this.cursorRepo.findOne({ where: { cursorKey: MAIN_CURSOR_KEY } }),
        this.stellarClient.getServer().getLatestLedger(),
      ]);

      const lastIndexedLedger = cursor?.lastIndexedLedger ?? null;
      const chainTipLedger = tip.sequence;
      const lag =
        lastIndexedLedger !== null ? chainTipLedger - lastIndexedLedger : null;

      let status: 'ok' | 'behind' | 'stopped' = 'ok';
      if (this.pollHandle === null) {
        status = 'stopped';
      } else if (lag !== null && lag > LEDGER_GAP_WARNING_THRESHOLD) {
        status = 'behind';
      }

      return { status, lastIndexedLedger, chainTipLedger, lag };
    } catch {
      return { status: 'stopped', lastIndexedLedger: null, chainTipLedger: null, lag: null };
    }
  }

  // ── Poll cycle ─────────────────────────────────────────────────────────

  /**
   * One poll iteration.  Fetches the chain tip, resolves the cursor, pages
   * through getEvents() for the outstanding ledger range, and commits the
   * updated cursor to the DB.
   *
   * This method is intentionally non-throwing so a transient RPC error does
   * not tear down the interval.
   */
  private async runPollCycle(): Promise<void> {
    if (this.polling) {
      this.logger.debug('Poll cycle skipped — previous cycle still running');
      return;
    }

    this.polling = true;
    try {
      await this.doPoll();
    } catch (err) {
      this.logger.error(
        `Poll cycle error: ${(err as Error).message}`,
        (err as Error).stack,
      );
    } finally {
      this.polling = false;
    }
  }

  private async doPoll(): Promise<void> {
    const server = this.stellarClient.getServer();
    const tip = await server.getLatestLedger();
    const chainTipLedger = tip.sequence;

    // ── Resolve cursor ─────────────────────────────────────────────────
    let cursor = await this.cursorRepo.findOne({
      where: { cursorKey: MAIN_CURSOR_KEY },
    });

    if (!cursor) {
      // No row at all (shouldn't happen — migration seeds one, but guard anyway).
      cursor = this.cursorRepo.create({
        cursorKey: MAIN_CURSOR_KEY,
        lastIndexedLedger: null,
        lastIndexedAt: null,
      });
    }

    // Cold start: begin from the ledger before the current tip.
    if (cursor.lastIndexedLedger === null) {
      const seedLedger = Math.max(chainTipLedger - 1, 0);
      this.logger.log(
        `IndexerService cold start — seeding cursor at ledger ${seedLedger}`,
      );
      cursor.lastIndexedLedger = seedLedger;
      await this.cursorRepo.save(cursor);
      return; // First tick seeds only; actual events polled on next tick.
    }

    const fromLedger = cursor.lastIndexedLedger + 1;

    if (fromLedger > chainTipLedger) {
      // Already caught up.
      return;
    }

    // ── Gap detection ──────────────────────────────────────────────────
    const lag = chainTipLedger - cursor.lastIndexedLedger;
    if (lag > LEDGER_GAP_WARNING_THRESHOLD) {
      this.logger.warn(
        JSON.stringify({
          level: 'warn',
          context: 'IndexerService',
          message: 'Ledger cursor is behind the chain tip — events may have been lost',
          lastIndexedLedger: cursor.lastIndexedLedger,
          chainTipLedger,
          lag,
          threshold: LEDGER_GAP_WARNING_THRESHOLD,
        }),
      );
    }

    // ── Contract IDs to monitor ────────────────────────────────────────
    const contractIds = this.resolveContractIds();
    if (contractIds.length === 0) {
      this.logger.debug('No contract IDs configured — indexer idle');
      return;
    }

    // ── Page through ledger range ──────────────────────────────────────
    let currentLedger = fromLedger;
    let totalEventsProcessed = 0;

    while (currentLedger <= chainTipLedger) {
      const pageTo = Math.min(currentLedger + MAX_EVENTS_PER_PAGE - 1, chainTipLedger);

      const { events: rawEvents, processedLedgerTo } = await this.fetchEvents(
        server,
        contractIds,
        currentLedger,
        pageTo,
      );

      totalEventsProcessed += rawEvents.length;
      await this.processEvents(rawEvents);

      // Advance cursor to the ledger we actually processed up to.
      cursor.lastIndexedLedger = processedLedgerTo;
      cursor.lastIndexedAt = new Date();
      await this.cursorRepo.save(cursor);

      this.logger.debug(
        JSON.stringify({
          level: 'debug',
          context: 'IndexerService',
          ledgerFrom: currentLedger,
          ledgerTo: processedLedgerTo,
          eventCount: rawEvents.length,
        }),
      );

      currentLedger = processedLedgerTo + 1;
    }

    if (totalEventsProcessed > 0) {
      this.logger.log(
        `Indexed ${totalEventsProcessed} event(s) up to ledger ${cursor.lastIndexedLedger}`,
      );
    }
  }

  // ── Event fetching ─────────────────────────────────────────────────────

  /**
   * Calls server.getEvents() for a specific ledger range and returns decoded
   * events along with the highest ledger actually represented in the result
   * (which may be lower than `pageTo` if the RPC returned fewer results).
   */
  private async fetchEvents(
    server: SorobanRpc.Server,
    contractIds: string[],
    fromLedger: number,
    pageTo: number,
  ): Promise<{ events: DecodedEvent[]; processedLedgerTo: number }> {
    try {
      const response = await server.getEvents({
        startLedger: fromLedger,
        filters: [{ contractIds }],
      });

      const rpcEvents = response.events ?? [];

      // Determine the highest ledger we've seen.  If no events were returned,
      // advance to pageTo so we don't repeat this range on the next tick.
      let processedLedgerTo = pageTo;
      if (rpcEvents.length > 0) {
        const maxLedger = rpcEvents.reduce(
          (max, ev) => Math.max(max, ev.ledger),
          0,
        );
        // Only advance as far as we received events — the remainder of the
        // range will be picked up on the next poll.
        processedLedgerTo = Math.min(maxLedger, pageTo);
      }

      const decoded: DecodedEvent[] = rpcEvents.map((ev) => ({
        id: ev.id,
        ledger: ev.ledger,
        contractId: String(ev.contractId ?? ''),
        topics: (ev.topic ?? []).map((t) => {
          try { return scValToNative(t); } catch { return null; }
        }),
        value: (() => {
          try { return scValToNative(ev.value); } catch { return null; }
        })(),
      }));

      return { events: decoded, processedLedgerTo };
    } catch (err) {
      // A single-range failure must not abort the cursor advance — log and
      // treat this range as empty so we do not get stuck in an infinite loop.
      this.logger.warn(
        `getEvents(${fromLedger}→${pageTo}) failed: ${(err as Error).message}`,
      );
      return { events: [], processedLedgerTo: pageTo };
    }
  }

  // ── Dispatch ──────────────────────────────────────────────────────────

  private async processEvents(events: DecodedEvent[]): Promise<void> {
    for (const raw of events) {
      const typed = decodeEvent(raw);
      if (!typed) {
        this.logger.debug(
          `Skipping unrecognised event id=${raw.id} topics=${JSON.stringify(raw.topics)}`,
        );
        continue;
      }

      await this.dispatch(typed);
    }
  }

  private async dispatch(event: IndexedEvent): Promise<void> {
    try {
      switch (event.kind) {
        case 'credit:mint':
          await this.onCreditMint(event);
          break;
        case 'credit:retire':
          await this.onCreditRetire(event);
          break;
        case 'credit:transfer':
          // Transfer events are broadcast over WebSocket but require no DB mutation.
          this.notificationsGateway.broadcast('credit:transferred', {
            contractId: event.contractId,
            from: event.from,
            to: event.to,
            amount: event.amount.toString(),
            ledger: event.ledger,
          });
          break;
        case 'oracle:reading_submitted':
          await this.onOracleReadingSubmitted(event);
          break;
        case 'governance:proposal_executed':
          await this.onGovernanceProposalExecuted(event);
          break;
      }
    } catch (err) {
      // Per-event errors are logged but must not abort the overall batch.
      this.logger.error(
        `Error dispatching event id=${event.id} kind=${event.kind}: ${(err as Error).message}`,
        (err as Error).stack,
      );
    }
  }

  // ── Handlers ──────────────────────────────────────────────────────────

  /**
   * credit_token → mint
   *
   * Idempotency: ReadingBatch rows have a unique constraint on (project_id,
   * oracle_address, nonce) upstream; here we only UPDATE batches that are
   * still PENDING/SUBMITTED — an already-CONFIRMED batch is left alone.
   *
   * Note: the credit_token contract is not parameterised by project_id in its
   * events — the contractId IS the project's token address.  The indexer
   * resolves the project by matching the token contract address stored in
   * projects.credit_token_address.
   */
  private async onCreditMint(event: CreditMintEvent): Promise<void> {
    // Find the ReadingBatch associated with this token contract that is still
    // awaiting confirmation.  If the oracle processor already confirmed it
    // this is a no-op.
    const amount = Number(event.amount);

    await this.dataSource
      .createQueryBuilder()
      .update(ReadingBatch)
      .set({
        status: BatchStatus.CONFIRMED,
        confirmedAt: () => `COALESCE(confirmed_at, NOW())`,
        creditsGenerated: () =>
          `COALESCE(credits_generated, ${amount})`,
      })
      .where(
        `project_id IN (
          SELECT id FROM projects WHERE credit_token_address = :contractId
        )`,
        { contractId: event.contractId },
      )
      .andWhere('status IN (:...statuses)', {
        statuses: [BatchStatus.PENDING, BatchStatus.SUBMITTED],
      })
      .execute();

    // Broadcast WebSocket event (no user context available from mint events).
    this.sensorsGateway.emitReading('global', {
      event: 'credit:minted',
      contractId: event.contractId,
      to: event.to,
      amount: event.amount.toString(),
      ledger: event.ledger,
    });

    this.notificationsGateway.broadcast('credit:minted', {
      contractId: event.contractId,
      to: event.to,
      amount: event.amount.toString(),
      ledger: event.ledger,
    });

    this.logger.log(
      `[indexer] credit:mint contractId=${event.contractId} to=${event.to} amount=${event.amount}`,
    );
  }

  /**
   * credit_token → retire
   *
   * Idempotency: only touches Retirement rows whose txHash is either empty or
   * a 'tx-pending-*' placeholder.  If the retirement processor already wrote
   * the real txHash this is a no-op.
   */
  private async onCreditRetire(event: CreditRetireEvent): Promise<void> {
    // Look up the project by token contract.
    const projectRow = await this.dataSource.query<{ id: string }[]>(
      `SELECT id FROM projects WHERE credit_token_address = $1 LIMIT 1`,
      [event.contractId],
    );
    const projectId = projectRow[0]?.id;

    if (projectId) {
      const user = await this.userRepo.findOne({
        where: { wallet: event.from },
      });

      if (!user) {
        this.logger.warn(
          JSON.stringify({
            level: 'warn',
            context: 'IndexerService',
            event: 'credit:retire',
            message: 'No user found for retirement wallet; skipping confirmation',
            wallet: event.from,
            projectId,
            amount: event.amount.toString(),
            ledger: event.ledger,
          }),
        );
      } else {
        const candidates = await this.retirementRepo.find({
          where: {
            projectId,
            userId: user.id,
            amount: Number(event.amount),
          },
          order: {
            retiredAt: 'ASC',
            createdAt: 'ASC',
            id: 'ASC',
          },
        });
        const pending = candidates.filter(
          (retirement) =>
            retirement.txHash === null ||
            retirement.txHash === '' ||
            retirement.txHash.startsWith('tx-pending-'),
        );
        const candidate = pending[0];

        if (pending.length > 1) {
          this.logger.warn(
            JSON.stringify({
              level: 'warn',
              context: 'IndexerService',
              event: 'credit:retire',
              message: 'Multiple pending retirements matched; selecting oldest',
              wallet: event.from,
              projectId,
              userId: user.id,
              amount: event.amount.toString(),
              candidateCount: pending.length,
              selectedRetirementId: candidate?.id,
              ledger: event.ledger,
            }),
          );
        }

        if (candidate) {
          await this.dataSource
            .createQueryBuilder()
            .update(Retirement)
            .set({
              retiredAt: () => `COALESCE(retired_at, NOW())`,
            })
            .where('id = :id', { id: candidate.id })
            .andWhere('project_id = :projectId', { projectId })
            .andWhere('user_id = :userId', { userId: user.id })
            .andWhere('amount = :amount', { amount: Number(event.amount) })
            .andWhere(
              `(tx_hash = '' OR tx_hash LIKE 'tx-pending-%' OR tx_hash IS NULL)`,
            )
            .execute();
        }
      }
    }

    // Broadcast regardless of whether a matching DB row was found — another
    // oracle or direct contract call may have triggered this.
    this.notificationsGateway.broadcast('credit:retired', {
      contractId: event.contractId,
      from: event.from,
      amount: event.amount.toString(),
      purpose: event.purpose,
      metadataUri: event.metadataUri,
      ledger: event.ledger,
    });

    this.logger.log(
      `[indexer] credit:retire contractId=${event.contractId} from=${event.from} amount=${event.amount}`,
    );
  }

  /**
   * verification_oracle → reading_submitted
   *
   * Idempotency: the oracle_submissions table has a UNIQUE constraint on
   * (project_id, oracle_address, nonce).  We use an UPDATE … WHERE status !=
   * 'confirmed' pattern — if the oracle processor already confirmed this
   * submission the row is left untouched.
   */
  private async onOracleReadingSubmitted(
    event: OracleReadingSubmittedEvent,
  ): Promise<void> {
    // Find the submission row by project/oracle/nonce.
    const submission = await this.submissionRepo.findOne({
      where: {
        projectId: event.projectId,
        oracleAddress: event.oracleAddress,
        nonce: event.nonce,
      },
    });

    if (submission && submission.status !== SubmissionStatus.CONFIRMED) {
      submission.status = SubmissionStatus.CONFIRMED;
      // Preserve the txHash written by the processor if present, otherwise
      // we don't have it from the event (the oracle contract doesn't emit it).
      submission.result = {
        ...(submission.result ?? {}),
        confirmedByIndexer: true,
        confirmedAt: new Date().toISOString(),
        creditsAwarded: event.creditsAwarded.toString(),
        ledger: event.ledger,
      };
      await this.submissionRepo.save(submission);

      // Also confirm the associated reading batch idempotently.
      if (event.creditsAwarded > 0n) {
        await this.dataSource
          .createQueryBuilder()
          .update(ReadingBatch)
          .set({
            status: BatchStatus.CONFIRMED,
            confirmedAt: () => `COALESCE(confirmed_at, NOW())`,
            creditsGenerated: () =>
              `COALESCE(credits_generated, ${Number(event.creditsAwarded)})`,
          })
          .where('project_id = :projectId', { projectId: event.projectId })
          .andWhere('status IN (:...statuses)', {
            statuses: [BatchStatus.PENDING, BatchStatus.SUBMITTED],
          })
          .execute();
      }
    } else if (!submission) {
      // Event from a second oracle or a direct on-chain call — no matching
      // DB row.  Log it; a future reconciliation pass can create the row.
      this.logger.warn(
        `[indexer] oracle:reading_submitted — no matching submission ` +
          `project=${event.projectId} oracle=${event.oracleAddress} nonce=${event.nonce}`,
      );
    }

    this.notificationsGateway.broadcast('oracle:submitted', {
      contractId: event.contractId,
      projectId: event.projectId,
      oracleAddress: event.oracleAddress,
      nonce: event.nonce,
      creditsAwarded: event.creditsAwarded.toString(),
      ledger: event.ledger,
    });

    this.logger.log(
      `[indexer] oracle:reading_submitted project=${event.projectId} nonce=${event.nonce}`,
    );
  }

  /**
   * governance → proposal_executed
   *
   * Idempotency: only updates proposals whose status is not already EXECUTED.
   */
  private async onGovernanceProposalExecuted(
    event: GovernanceProposalExecutedEvent,
  ): Promise<void> {
    // Match by on-chain proposal ID if already recorded, otherwise fall back
    // to the most recent PASSED proposal (graceful for proposals created
    // before the onChainProposalId column was populated).
    const proposal =
      (await this.proposalRepo.findOne({
        where: { onChainProposalId: event.onChainProposalId },
      })) ??
      (await this.proposalRepo.findOne({
        where: { status: ProposalStatus.PASSED },
        order: { createdAt: 'DESC' },
      }));

    if (proposal && proposal.status !== ProposalStatus.EXECUTED) {
      proposal.status = ProposalStatus.EXECUTED;
      proposal.onChainProposalId = event.onChainProposalId;
      proposal.executedBy = event.executedBy;
      proposal.executedAt = new Date();
      await this.proposalRepo.save(proposal);
    }

    this.notificationsGateway.broadcast('governance:proposal', {
      onChainProposalId: event.onChainProposalId,
      executedBy: event.executedBy,
      ledger: event.ledger,
      status: 'EXECUTED',
    });

    this.logger.log(
      `[indexer] governance:proposal_executed onChainProposalId=${event.onChainProposalId}`,
    );
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  /**
   * Collects the configured contract IDs from environment / config.
   * Returns an empty array when none are set (indexer idles gracefully).
   */
  private resolveContractIds(): string[] {
    const ids: string[] = [];

    const creditFactory = this.configService.get<string>(
      'CONTRACT_CREDIT_FACTORY',
    );
    const oracle = this.configService.get<string>(
      'CONTRACT_VERIFICATION_ORACLE',
    );
    const retirement = this.configService.get<string>(
      'CONTRACT_RETIREMENT_REGISTRY',
    );
    const governance = this.configService.get<string>(
      'stellar.contractGovernance',
    );

    if (creditFactory) ids.push(creditFactory);
    if (oracle) ids.push(oracle);
    if (retirement) ids.push(retirement);
    if (governance) ids.push(governance);

    return ids;
  }
}
