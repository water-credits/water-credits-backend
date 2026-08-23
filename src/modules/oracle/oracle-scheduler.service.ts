import {
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import { Cron, SchedulerRegistry } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, MoreThan, Repository } from 'typeorm';
import { OracleService } from './oracle.service';
import {
  GLOBAL_SCHEDULE_SCOPE,
  OracleScheduleState,
} from './entities/oracle-schedule-state.entity';
import { Project, ProjectStatus } from '../projects/entities/project.entity';
import {
  BATCH_WINDOW_MS,
  BatchStatus,
  ReadingBatch,
} from '../sensors/entities/reading-batch.entity';
import { DEFAULT_ORACLE_SUBMISSION_CRON } from '../../config/oracle.config';

/** Name the cron job is registered under in the SchedulerRegistry. */
export const ORACLE_SUBMISSION_CRON_NAME = 'oracle-submission-cycle';

/**
 * Resolves the cron expression at decoration time.
 *
 * `@Cron()` is evaluated when the class is defined, which is before Nest can
 * inject ConfigService, so the env var is read directly here.  The same value
 * is re-read through ConfigService at runtime for logging and `GET /health`.
 */
export function resolveCronExpression(): string {
  const raw = (process.env.ORACLE_SUBMISSION_INTERVAL_CRON || '').trim();
  if (!raw) {
    return DEFAULT_ORACLE_SUBMISSION_CRON;
  }

  const fieldCount = raw.split(/\s+/).length;
  if (fieldCount < 5 || fieldCount > 6) {
    // Don't take the whole app down for a typo in an operator's env file —
    // fall back to hourly and make the mistake loud.
    Logger.warn(
      `Ignoring malformed ORACLE_SUBMISSION_INTERVAL_CRON="${raw}" ` +
        `(expected 5 or 6 fields); falling back to "${DEFAULT_ORACLE_SUBMISSION_CRON}"`,
      'OracleSchedulerService',
    );
    return DEFAULT_ORACLE_SUBMISSION_CRON;
  }

  return raw;
}

/** Name the cron job is registered under in the SchedulerRegistry for reconciliation. */
export const ORACLE_RECONCILIATION_CRON_NAME = 'oracle-reconciliation-cycle';

/**
 * Resolves the reconciliation cron expression at decoration time.
 */
export function resolveReconciliationCronExpression(): string {
  const raw = (process.env.ORACLE_RECONCILIATION_INTERVAL_CRON || '').trim();
  if (!raw) {
    return '30 * * * *';
  }

  const fieldCount = raw.split(/\s+/).length;
  if (fieldCount < 5 || fieldCount > 6) {
    Logger.warn(
      `Ignoring malformed ORACLE_RECONCILIATION_INTERVAL_CRON="${raw}" ` +
        `(expected 5 or 6 fields); falling back to "30 * * * *"`,
      'OracleSchedulerService',
    );
    return '30 * * * *';
  }

  return raw;
}

export interface SubmissionCycleResult {
  /** Number of ACTIVE projects inspected. */
  projectsScanned: number;
  /** Number of batches claimed and enqueued for submission. */
  submitted: number;
  /** Number of batches that failed to submit and were released back to PENDING. */
  failed: number;
  /** True when the cycle was skipped entirely (disabled, misconfigured, overlapping). */
  skipped: boolean;
}

/**
 * Drives the hourly oracle submission cycle the README specifies.
 *
 * Before this existed, the sensor → credit pipeline only advanced when an
 * operator called `POST /oracle/trigger` by hand.
 */
@Injectable()
export class OracleSchedulerService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(OracleSchedulerService.name);

  /** Guards against a slow cycle overlapping the next tick. */
  private running = false;

  /** Set on shutdown so an in-flight cycle stops between units of work. */
  private shuttingDown = false;

  constructor(
    private readonly oracleService: OracleService,
    private readonly configService: ConfigService,
    private readonly schedulerRegistry: SchedulerRegistry,
    @InjectRepository(Project)
    private readonly projectRepo: Repository<Project>,
    @InjectRepository(ReadingBatch)
    private readonly batchRepo: Repository<ReadingBatch>,
    @InjectRepository(OracleScheduleState)
    private readonly scheduleStateRepo: Repository<OracleScheduleState>,
  ) {}

  onModuleInit(): void {
    const expression = this.configService.get<string>(
      'oracle.submissionIntervalCron',
      DEFAULT_ORACLE_SUBMISSION_CRON,
    );
    if (this.isEnabled()) {
      this.logger.log(`Oracle submission cycle scheduled with cron "${expression}"`);
      const reconExpression = resolveReconciliationCronExpression();
      this.logger.log(`Oracle reconciliation cycle scheduled with cron "${reconExpression}"`);
    } else {
      this.logger.warn('Oracle submission cycle is DISABLED (ORACLE_SCHEDULER_ENABLED=false)');
    }
  }

  /**
   * Stops the cron on shutdown so a terminating pod cannot fire a spurious
   * submission while it drains.
   */
  onApplicationShutdown(signal?: string): void {
    this.shuttingDown = true;
    try {
      this.schedulerRegistry.getCronJob(ORACLE_SUBMISSION_CRON_NAME).stop();
      this.logger.log(`Oracle submission cron stopped (signal: ${signal ?? 'none'})`);
    } catch {
      // Job was never registered (e.g. ScheduleModule absent in a unit test).
    }
    try {
      this.schedulerRegistry.getCronJob(ORACLE_RECONCILIATION_CRON_NAME).stop();
      this.logger.log(`Oracle reconciliation cron stopped (signal: ${signal ?? 'none'})`);
    } catch {
      // Job was never registered.
    }
  }

  @Cron(resolveCronExpression(), { name: ORACLE_SUBMISSION_CRON_NAME })
  async handleCron(): Promise<SubmissionCycleResult> {
    return this.runSubmissionCycle();
  }

  @Cron(resolveReconciliationCronExpression(), { name: ORACLE_RECONCILIATION_CRON_NAME })
  async handleReconciliationCron(): Promise<void> {
    await this.runReconciliation();
  }

  /**
   * One submission cycle: every ACTIVE project, in sequence, has its closed
   * non-empty PENDING batches submitted — also in sequence, because the oracle
   * nonce is per-(project, oracle_address) and parallel submissions for one
   * project would collide on it.
   */
  async runSubmissionCycle(): Promise<SubmissionCycleResult> {
    const empty: SubmissionCycleResult = {
      projectsScanned: 0,
      submitted: 0,
      failed: 0,
      skipped: true,
    };

    if (!this.isEnabled() || this.shuttingDown) {
      return empty;
    }

    const oracleAddress = this.configService.get<string>('oracle.address', '');
    if (!oracleAddress) {
      this.logger.warn('Skipping scheduled oracle cycle: ORACLE_ADDRESS is not configured');
      return empty;
    }

    if (this.running) {
      this.logger.warn('Previous oracle submission cycle still running, skipping this tick');
      return empty;
    }

    this.running = true;
    const startedAt = new Date();
    let submitted = 0;
    let failed = 0;
    let projects: Project[] = [];

    try {
      projects = await this.projectRepo.find({
        where: { status: ProjectStatus.ACTIVE },
        order: { createdAt: 'ASC' },
      });

      for (const project of projects) {
        if (this.shuttingDown) {
          this.logger.log('Shutdown requested, aborting oracle submission cycle');
          break;
        }

        const result = await this.submitProjectBatches(project.id, oracleAddress);
        submitted += result.submitted;
        failed += result.failed;

        if (result.submitted > 0) {
          await this.recordScheduleState(project.id, startedAt, result.submitted);
        }
      }

      await this.recordScheduleState(GLOBAL_SCHEDULE_SCOPE, startedAt, submitted);

      this.logger.log(
        `Oracle submission cycle finished: ${projects.length} active project(s), ` +
          `${submitted} submitted, ${failed} failed`,
      );
    } catch (error) {
      // A cron tick has no caller to catch for it; swallowing here keeps an
      // unhandled rejection from taking down the process and lets the next
      // tick try again.
      this.logger.error(`Oracle submission cycle aborted: ${(error as Error).message}`);
      return { projectsScanned: projects.length, submitted, failed: failed + 1, skipped: false };
    } finally {
      this.running = false;
    }

    return { projectsScanned: projects.length, submitted, failed, skipped: false };
  }

  /**
   * Submits every eligible batch for one project, strictly one at a time.
   */
  private async submitProjectBatches(
    projectId: string,
    oracleAddress: string,
  ): Promise<{ submitted: number; failed: number }> {
    const batches = await this.findEligibleBatches(projectId);
    let submitted = 0;
    let failed = 0;

    for (const batch of batches) {
      if (this.shuttingDown) {
        break;
      }

      // Claim the batch before doing any work.  The conditional UPDATE is the
      // idempotency barrier: only the caller that flips PENDING → SUBMITTED
      // proceeds, so a manual trigger, a second replica, or an overlapping
      // tick cannot submit the same batch twice.
      const claim = await this.batchRepo.update(
        { id: batch.id, status: BatchStatus.PENDING },
        { status: BatchStatus.SUBMITTED, submittedAt: new Date() },
      );

      if (claim.affected !== 1) {
        this.logger.debug(`Batch ${batch.id} already claimed elsewhere, skipping`);
        continue;
      }

      try {
        const aggregate = await this.oracleService.aggregateReadingsForBatch(projectId, batch.id);

        await this.oracleService.triggerSubmission({
          projectId,
          oracleAddress,
          readings: this.toReadingsSnapshot(aggregate),
        });

        submitted += 1;
        this.logger.log(
          `Scheduled submission for project ${projectId} batch ${batch.id} ` +
            `(${aggregate.oracleCount} verified readings)`,
        );
      } catch (error) {
        failed += 1;
        // Release the claim so the next cycle can retry this batch.
        await this.batchRepo.update(
          { id: batch.id, status: BatchStatus.SUBMITTED },
          { status: BatchStatus.PENDING, submittedAt: null },
        );

        if (error instanceof NotFoundException) {
          this.logger.warn(
            `Batch ${batch.id} has no verified readings to aggregate, released for retry`,
          );
        } else {
          this.logger.error(
            `Scheduled submission failed for project ${projectId} batch ${batch.id}: ` +
              `${(error as Error).message}`,
          );
        }
      }
    }

    return { submitted, failed };
  }

  /**
   * Eligible = PENDING, has readings, and its collection window has closed.
   * Batches still inside the 15-minute window are left alone so a partial
   * window is never submitted.
   */
  private findEligibleBatches(projectId: string): Promise<ReadingBatch[]> {
    const windowClosedBefore = new Date(Date.now() - BATCH_WINDOW_MS);

    return this.batchRepo.find({
      where: {
        projectId,
        status: BatchStatus.PENDING,
        readingCount: MoreThan(0),
        createdAt: LessThan(windowClosedBefore),
      },
      order: { createdAt: 'ASC' },
    });
  }

  /**
   * Flattens an aggregate into the `Record<string, number>` shape
   * `TriggerSubmissionDto.readings` accepts, dropping null medians.
   */
  private toReadingsSnapshot(aggregate: {
    medianPh: number | null;
    medianTurbidity: number | null;
    medianDissolvedOxygen: number | null;
    medianFlowRate: number | null;
    medianNitrogen: number | null;
    medianPhosphorus: number | null;
    medianTemperature: number | null;
    oracleCount: number;
  }): Record<string, number> {
    const snapshot: Record<string, number> = { oracleCount: aggregate.oracleCount };
    const fields: Array<[string, number | null]> = [
      ['ph', aggregate.medianPh],
      ['turbidity', aggregate.medianTurbidity],
      ['dissolvedOxygen', aggregate.medianDissolvedOxygen],
      ['flowRate', aggregate.medianFlowRate],
      ['nitrogen', aggregate.medianNitrogen],
      ['phosphorus', aggregate.medianPhosphorus],
      ['temperature', aggregate.medianTemperature],
    ];

    for (const [key, value] of fields) {
      if (value !== null) {
        snapshot[key] = value;
      }
    }

    return snapshot;
  }

  private async recordScheduleState(
    scopeId: string,
    lastScheduledAt: Date,
    lastSubmissionCount: number,
  ): Promise<void> {
    try {
      await this.scheduleStateRepo.upsert({ scopeId, lastScheduledAt, lastSubmissionCount }, [
        'scopeId',
      ]);
    } catch (error) {
      // Freshness bookkeeping must never fail a submission cycle.
      this.logger.warn(
        `Could not record schedule state for "${scopeId}": ${(error as Error).message}`,
      );
    }
  }

  private isEnabled(): boolean {
    return this.configService.get<boolean>('oracle.schedulerEnabled', true);
  }

  async runReconciliation(): Promise<void> {
    if (!this.isEnabled() || this.shuttingDown) {
      return;
    }

    const oracleContractId = this.configService.get<string>('oracle.contractId');
    if (!oracleContractId) {
      this.logger.warn('Skipping scheduled reconciliation: oracle contract ID is not configured');
      return;
    }

    const oracleAddresses = await this.oracleService.getUniqueOracleAddresses();
    if (oracleAddresses.length === 0) {
      return;
    }

    this.logger.log(`Starting oracle reconciliation cycle for ${oracleAddresses.length} oracle(s)`);
    for (const oracleAddress of oracleAddresses) {
      if (this.shuttingDown) {
        break;
      }
      await this.oracleService.reconcile(oracleContractId, oracleAddress);
    }
  }
}
