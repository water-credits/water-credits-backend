import { Test, TestingModule } from '@nestjs/testing';
import { Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { getRepositoryToken } from '@nestjs/typeorm';
import { getQueueToken } from '@nestjs/bull';
import { DataSource, FindOperator } from 'typeorm';
import { ORACLE_SUBMISSION_CRON_NAME, OracleSchedulerService } from './oracle-scheduler.service';
import { NotificationsService } from '../notifications/notifications.service';
import { OracleService, AggregatedReading } from './oracle.service';
import { OracleSubmission } from './entities/oracle-submission.entity';
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
import { SensorReading } from '../sensors/entities/sensor-reading.entity';
import { StellarService } from '../stellar/stellar.service';
import { GovernanceConfig } from '../governance/entities/governance-config.entity';
import { CreditScoringService } from './credit-scoring.service';

// ── In-memory repositories ────────────────────────────────────────────────────
//
// These evaluate TypeORM's FindOperators for real (MoreThan / LessThan), so the
// batch-selection tests exercise the actual predicate the scheduler builds
// rather than asserting on the shape of a `where` object.

function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, expected]) => {
    const actual = row[key];
    if (expected instanceof FindOperator) {
      const value = expected.value as number | Date;
      switch (expected.type) {
        case 'moreThan':
          return (actual as number) > (value as number);
        case 'lessThan':
          return (actual as Date) < (value as Date);
        default:
          throw new Error(`Unsupported FindOperator in test: ${expected.type}`);
      }
    }
    return actual === expected;
  });
}

class InMemoryBatchRepo {
  constructor(public rows: ReadingBatch[]) {}

  async find(options: {
    where: Record<string, unknown>;
    order?: Record<string, 'ASC' | 'DESC'>;
  }): Promise<ReadingBatch[]> {
    const found = this.rows.filter((row) =>
      matches(row as unknown as Record<string, unknown>, options.where),
    );
    return found.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  /**
   * Conditional update, mirroring `UPDATE … WHERE id = $1 AND status = $2`.
   * Synchronous body: whichever caller reaches it first wins, exactly like the
   * single row-lock Postgres grants.
   */
  async update(
    criteria: Record<string, unknown>,
    partial: Partial<ReadingBatch>,
  ): Promise<{ affected: number }> {
    const target = this.rows.find((row) =>
      matches(row as unknown as Record<string, unknown>, criteria),
    );
    if (!target) {
      return { affected: 0 };
    }
    Object.assign(target, partial);
    return { affected: 1 };
  }
}

function makeBatch(overrides: Partial<ReadingBatch> & { id: string }): ReadingBatch {
  return {
    projectId: 'project-active',
    status: BatchStatus.PENDING,
    readingCount: 5,
    creditsGenerated: null,
    submittedAt: null,
    confirmedAt: null,
    createdAt: new Date(Date.now() - BATCH_WINDOW_MS - 60_000),
    updatedAt: new Date(),
    ...overrides,
  } as ReadingBatch;
}

function makeProject(id: string, status: ProjectStatus): Project {
  return { id, status, createdAt: new Date() } as Project;
}

const AGGREGATE: AggregatedReading = {
  medianPh: 7.1,
  medianTurbidity: 2.5,
  medianDissolvedOxygen: 8.4,
  medianFlowRate: 12,
  medianNitrogen: null,
  medianPhosphorus: 0.4,
  medianTemperature: 19.5,
  oracleCount: 5,
  startTime: new Date(),
  endTime: new Date(),
};

const ORACLE_ADDRESS = 'GORACLE00000000000000000000000000000000000000000000000AA';

interface HarnessOptions {
  projects?: Project[];
  batches?: ReadingBatch[];
  config?: Record<string, unknown>;
  oracleService?: Partial<OracleService>;
}

interface Harness {
  scheduler: OracleSchedulerService;
  batchRepo: InMemoryBatchRepo;
  scheduleStateRepo: { upsert: jest.Mock; rows: Record<string, unknown>[] };
  projectRepo: { find: jest.Mock };
  triggerSubmission: jest.Mock;
  aggregateReadingsForBatch: jest.Mock;
  detectNonceDrift: jest.Mock;
  cronJob: { stop: jest.Mock };
  module: TestingModule;
}

async function buildHarness(options: HarnessOptions = {}): Promise<Harness> {
  const batchRepo = new InMemoryBatchRepo(options.batches ?? []);
  const projects = options.projects ?? [makeProject('project-active', ProjectStatus.ACTIVE)];

  const projectRepo = {
    find: jest.fn(async (opts: { where: Record<string, unknown> }) =>
      projects.filter((p) => matches(p as unknown as Record<string, unknown>, opts.where)),
    ),
  };

  const stateRows: Record<string, unknown>[] = [];
  const scheduleStateRepo = {
    rows: stateRows,
    upsert: jest.fn(async (entity: Record<string, unknown>) => {
      stateRows.push(entity);
      return { identifiers: [] };
    }),
  };

  const triggerSubmission = jest.fn(async () => ({ id: 'submission-1' }) as OracleSubmission);
  const oracleService = {
    aggregateReadingsForBatch: jest.fn(async () => AGGREGATE),
    triggerSubmission,
    detectNonceDrift: jest.fn(async () => 0),
    ...options.oracleService,
  };

  const configValues: Record<string, unknown> = {
    'oracle.schedulerEnabled': true,
    'oracle.address': ORACLE_ADDRESS,
    'oracle.submissionIntervalCron': '0 * * * *',
    'oracle.contractId': 'CORACLE_CONTRACT_ID',
    ...options.config,
  };

  const cronJob = { stop: jest.fn() };

  const module = await Test.createTestingModule({
    providers: [
      OracleSchedulerService,
      { provide: NotificationsService, useValue: { notifyOracleMissedSubmissions: jest.fn() } },
      { provide: OracleService, useValue: oracleService },
      {
        provide: ConfigService,
        useValue: {
          get: jest.fn((key: string, fallback?: unknown) =>
            key in configValues ? configValues[key] : fallback,
          ),
        },
      },
      { provide: SchedulerRegistry, useValue: { getCronJob: jest.fn(() => cronJob) } },
      { provide: getRepositoryToken(Project), useValue: projectRepo },
      { provide: getRepositoryToken(ReadingBatch), useValue: batchRepo },
      { provide: getRepositoryToken(OracleScheduleState), useValue: scheduleStateRepo },
    ],
  }).compile();

  return {
    scheduler: module.get(OracleSchedulerService),
    batchRepo,
    scheduleStateRepo,
    projectRepo,
    triggerSubmission: oracleService.triggerSubmission as jest.Mock,
    aggregateReadingsForBatch: oracleService.aggregateReadingsForBatch as jest.Mock,
    detectNonceDrift: oracleService.detectNonceDrift as jest.Mock,
    cronJob,
    module,
  };
}

describe('OracleSchedulerService', () => {
  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterAll(() => jest.restoreAllMocks());

  // ── Acceptance: selects only active projects with closed, non-empty batches ──

  describe('batch selection', () => {
    it('submits a closed, non-empty batch of an ACTIVE project', async () => {
      const { scheduler, triggerSubmission, batchRepo } = await buildHarness({
        batches: [makeBatch({ id: 'batch-closed' })],
      });

      const result = await scheduler.runSubmissionCycle();

      expect(result).toMatchObject({ projectsScanned: 1, submitted: 1, failed: 0, skipped: false });
      expect(triggerSubmission).toHaveBeenCalledTimes(1);
      expect(triggerSubmission).toHaveBeenCalledWith({
        projectId: 'project-active',
        oracleAddress: ORACLE_ADDRESS,
        batchId: 'batch-closed',
        readings: {
          oracleCount: 5,
          ph: 7.1,
          turbidity: 2.5,
          dissolvedOxygen: 8.4,
          flowRate: 12,
          phosphorus: 0.4,
          temperature: 19.5,
        },
      });
      // nitrogen was null in the aggregate and must not appear in the snapshot
      expect(triggerSubmission.mock.calls[0][0].readings).not.toHaveProperty('nitrogen');
      expect(batchRepo.rows[0].status).toBe(BatchStatus.SUBMITTED);
      expect(batchRepo.rows[0].submittedAt).toBeInstanceOf(Date);
    });

    it('skips a batch whose 15-minute window is still open', async () => {
      const openBatch = makeBatch({
        id: 'batch-open',
        createdAt: new Date(Date.now() - 5 * 60 * 1000),
      });
      const { scheduler, triggerSubmission, batchRepo } = await buildHarness({
        batches: [openBatch],
      });

      const result = await scheduler.runSubmissionCycle();

      expect(result.submitted).toBe(0);
      expect(triggerSubmission).not.toHaveBeenCalled();
      expect(batchRepo.rows[0].status).toBe(BatchStatus.PENDING);
    });

    it('skips an empty batch even once its window has closed', async () => {
      const { scheduler, triggerSubmission } = await buildHarness({
        batches: [makeBatch({ id: 'batch-empty', readingCount: 0 })],
      });

      await scheduler.runSubmissionCycle();

      expect(triggerSubmission).not.toHaveBeenCalled();
    });

    it('skips batches that are no longer PENDING', async () => {
      const { scheduler, triggerSubmission } = await buildHarness({
        batches: [
          makeBatch({ id: 'batch-submitted', status: BatchStatus.SUBMITTED }),
          makeBatch({ id: 'batch-confirmed', status: BatchStatus.CONFIRMED }),
        ],
      });

      await scheduler.runSubmissionCycle();

      expect(triggerSubmission).not.toHaveBeenCalled();
    });

    it('ignores projects that are not ACTIVE', async () => {
      const { scheduler, triggerSubmission, projectRepo } = await buildHarness({
        projects: [
          makeProject('project-draft', ProjectStatus.DRAFT),
          makeProject('project-completed', ProjectStatus.COMPLETED),
          makeProject('project-active', ProjectStatus.ACTIVE),
        ],
        batches: [
          makeBatch({ id: 'batch-draft', projectId: 'project-draft' }),
          makeBatch({ id: 'batch-completed', projectId: 'project-completed' }),
          makeBatch({ id: 'batch-active', projectId: 'project-active' }),
        ],
      });

      const result = await scheduler.runSubmissionCycle();

      expect(projectRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({ where: { status: ProjectStatus.ACTIVE } }),
      );
      expect(result.projectsScanned).toBe(1);
      expect(triggerSubmission).toHaveBeenCalledTimes(1);
      expect(triggerSubmission.mock.calls[0][0].projectId).toBe('project-active');
      expect(triggerSubmission.mock.calls[0][0].batchId).toBe('batch-active');
    });

    it('submits older batches first', async () => {
      const older = makeBatch({
        id: 'batch-older',
        createdAt: new Date(Date.now() - BATCH_WINDOW_MS - 3_600_000),
      });
      const newer = makeBatch({
        id: 'batch-newer',
        createdAt: new Date(Date.now() - BATCH_WINDOW_MS - 60_000),
      });
      const { scheduler, aggregateReadingsForBatch } = await buildHarness({
        batches: [newer, older],
      });

      await scheduler.runSubmissionCycle();

      const submittedOrder = aggregateReadingsForBatch.mock.calls.map((call) => call[1]);
      expect(submittedOrder).toEqual(['batch-older', 'batch-newer']);
    });
  });

  // ── Acceptance: per-project serialisation ───────────────────────────────────

  describe('serialisation', () => {
    it('submits a project’s batches one at a time, never concurrently', async () => {
      let inFlight = 0;
      let maxInFlight = 0;
      const triggerSubmission = jest.fn(async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return { id: 'submission' } as OracleSubmission;
      });

      const { scheduler } = await buildHarness({
        batches: [
          makeBatch({ id: 'batch-a' }),
          makeBatch({ id: 'batch-b' }),
          makeBatch({ id: 'batch-c' }),
        ],
        oracleService: { triggerSubmission } as unknown as Partial<OracleService>,
      });

      const result = await scheduler.runSubmissionCycle();

      expect(result.submitted).toBe(3);
      expect(maxInFlight).toBe(1);
    });

    it('skips a tick while the previous cycle is still running', async () => {
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const triggerSubmission = jest.fn(async () => {
        await gate;
        return { id: 'submission' } as OracleSubmission;
      });

      const { scheduler } = await buildHarness({
        batches: [makeBatch({ id: 'batch-slow' })],
        oracleService: { triggerSubmission } as unknown as Partial<OracleService>,
      });

      const first = scheduler.runSubmissionCycle();
      await new Promise((resolve) => setImmediate(resolve));
      const second = await scheduler.runSubmissionCycle();

      expect(second.skipped).toBe(true);
      release();
      await expect(first).resolves.toMatchObject({ submitted: 1 });
      expect(triggerSubmission).toHaveBeenCalledTimes(1);
    });
  });

  // ── Acceptance: idempotency ─────────────────────────────────────────────────

  describe('idempotency', () => {
    it('never submits the same batch twice when two cycles race', async () => {
      const { scheduler, triggerSubmission } = await buildHarness({
        batches: [makeBatch({ id: 'batch-contended' })],
      });
      // Bypass the in-process `running` guard to model two replicas (or a cron
      // tick racing a manual sweep) hitting the same row.
      const other = (await buildHarness({ batches: [] })).scheduler;
      Object.defineProperty(other, 'batchRepo', {
        value: (scheduler as unknown as { batchRepo: unknown }).batchRepo,
      });

      await Promise.all([scheduler.runSubmissionCycle(), scheduler.runSubmissionCycle()]);

      expect(triggerSubmission).toHaveBeenCalledTimes(1);
    });

    it('releases the claim so a failed batch is retried next cycle', async () => {
      const triggerSubmission = jest
        .fn()
        .mockRejectedValueOnce(new Error('stellar rpc unavailable'))
        .mockResolvedValueOnce({ id: 'submission-retry' } as OracleSubmission);

      const { scheduler, batchRepo } = await buildHarness({
        batches: [makeBatch({ id: 'batch-retry' })],
        oracleService: { triggerSubmission } as unknown as Partial<OracleService>,
      });

      const failedCycle = await scheduler.runSubmissionCycle();
      expect(failedCycle).toMatchObject({ submitted: 0, failed: 1 });
      expect(batchRepo.rows[0].status).toBe(BatchStatus.PENDING);
      expect(batchRepo.rows[0].submittedAt).toBeNull();

      const retryCycle = await scheduler.runSubmissionCycle();
      expect(retryCycle.submitted).toBe(1);
      expect(batchRepo.rows[0].status).toBe(BatchStatus.SUBMITTED);
    });

    it('releases the claim when a batch has no verified readings to aggregate', async () => {
      const { scheduler, batchRepo } = await buildHarness({
        batches: [makeBatch({ id: 'batch-unverified' })],
        oracleService: {
          aggregateReadingsForBatch: jest.fn().mockRejectedValue(new NotFoundException('none')),
        } as unknown as Partial<OracleService>,
      });

      const result = await scheduler.runSubmissionCycle();

      expect(result).toMatchObject({ submitted: 0, failed: 1 });
      expect(batchRepo.rows[0].status).toBe(BatchStatus.PENDING);
    });
  });

  // ── Acceptance: freshness bookkeeping ───────────────────────────────────────

  describe('freshness tracking', () => {
    it('records last_scheduled_at globally and per project', async () => {
      const { scheduler, scheduleStateRepo } = await buildHarness({
        batches: [makeBatch({ id: 'batch-fresh' })],
      });

      await scheduler.runSubmissionCycle();

      // upsert calls: per-project, global (schedule state), global (nonce drift)
      const scopes = scheduleStateRepo.upsert.mock.calls.map((call) => call[0].scopeId);
      expect(scopes).toEqual(['project-active', GLOBAL_SCHEDULE_SCOPE, GLOBAL_SCHEDULE_SCOPE]);
      // The schedule-state upsert is the second-to-last call (before the drift upsert)
      const scheduleStateCall = scheduleStateRepo.upsert.mock.calls.at(-2)?.[0];
      expect(scheduleStateCall.lastScheduledAt).toBeInstanceOf(Date);
      expect(scheduleStateCall.lastSubmissionCount).toBe(1);
    });

    it('records the global timestamp even when nothing was due', async () => {
      const { scheduler, scheduleStateRepo } = await buildHarness({ batches: [] });

      await scheduler.runSubmissionCycle();

      // 2 upserts: schedule state + nonce drift (both on global scope)
      expect(scheduleStateRepo.upsert).toHaveBeenCalledTimes(2);
      expect(scheduleStateRepo.upsert.mock.calls[0][0]).toMatchObject({
        scopeId: GLOBAL_SCHEDULE_SCOPE,
        lastSubmissionCount: 0,
      });
    });

    it('does not fail the cycle when freshness bookkeeping errors', async () => {
      const { scheduler, scheduleStateRepo, triggerSubmission } = await buildHarness({
        batches: [makeBatch({ id: 'batch-ok' })],
      });
      scheduleStateRepo.upsert.mockRejectedValue(new Error('table missing'));

      await expect(scheduler.runSubmissionCycle()).resolves.toMatchObject({ submitted: 1 });
      expect(triggerSubmission).toHaveBeenCalledTimes(1);
    });
  });

  // ── Acceptance: nonce-drift detection ──────────────────────────────────────

  describe('nonce drift', () => {
    it('calls detectNonceDrift once per cycle with the configured contract ID and oracle address', async () => {
      const { scheduler, detectNonceDrift } = await buildHarness({
        batches: [makeBatch({ id: 'batch-drift' })],
      });

      await scheduler.runSubmissionCycle();

      expect(detectNonceDrift).toHaveBeenCalledTimes(1);
      expect(detectNonceDrift).toHaveBeenCalledWith('CORACLE_CONTRACT_ID', ORACLE_ADDRESS);
    });

    it('persists the drift value returned by detectNonceDrift', async () => {
      const { scheduler, scheduleStateRepo } = await buildHarness({
        batches: [],
        oracleService: { detectNonceDrift: jest.fn(async () => 3) } as unknown as Partial<OracleService>,
      });

      await scheduler.runSubmissionCycle();

      const driftUpsert = scheduleStateRepo.upsert.mock.calls.find(
        (call) => call[0].lastNonceDrift !== undefined,
      );
      expect(driftUpsert).toBeDefined();
      expect(driftUpsert![0]).toMatchObject({
        scopeId: GLOBAL_SCHEDULE_SCOPE,
        lastNonceDrift: 3,
      });
    });

    it('persists null when detectNonceDrift returns null (RPC failure)', async () => {
      const { scheduler, scheduleStateRepo } = await buildHarness({
        batches: [],
        oracleService: { detectNonceDrift: jest.fn(async () => null) } as unknown as Partial<OracleService>,
      });

      await scheduler.runSubmissionCycle();

      const driftUpsert = scheduleStateRepo.upsert.mock.calls.find(
        (call) => call[0].lastNonceDrift !== undefined,
      );
      expect(driftUpsert![0].lastNonceDrift).toBeNull();
    });

    it('skips the drift check when oracle.contractId is not configured', async () => {
      const { scheduler, detectNonceDrift } = await buildHarness({
        batches: [],
        config: { 'oracle.contractId': '' },
      });

      await scheduler.runSubmissionCycle();

      expect(detectNonceDrift).not.toHaveBeenCalled();
    });

    it('does not fail the cycle when the drift upsert throws', async () => {
      const { scheduler, scheduleStateRepo, triggerSubmission } = await buildHarness({
        batches: [makeBatch({ id: 'batch-drift-error' })],
      });
      // Make only the drift upsert (the one carrying lastNonceDrift) throw.
      scheduleStateRepo.upsert.mockImplementation(async (entity: Record<string, unknown>) => {
        if (entity.lastNonceDrift !== undefined) {
          throw new Error('column missing');
        }
        return { identifiers: [] };
      });

      await expect(scheduler.runSubmissionCycle()).resolves.toMatchObject({ submitted: 1 });
      expect(triggerSubmission).toHaveBeenCalledTimes(1);
    });
  });

  describe('resilience', () => {
    it('reports rather than throws when the project query fails', async () => {
      const { scheduler, projectRepo } = await buildHarness();
      projectRepo.find.mockRejectedValue(new Error('connection terminated'));

      await expect(scheduler.runSubmissionCycle()).resolves.toMatchObject({
        skipped: false,
        submitted: 0,
        failed: 1,
      });
    });

    it('clears the running guard after a failed cycle so the next tick proceeds', async () => {
      const { scheduler, projectRepo, triggerSubmission } = await buildHarness({
        batches: [makeBatch({ id: 'batch-after-failure' })],
      });
      projectRepo.find.mockRejectedValueOnce(new Error('connection terminated'));

      await scheduler.runSubmissionCycle();
      const recovered = await scheduler.runSubmissionCycle();

      expect(recovered.submitted).toBe(1);
      expect(triggerSubmission).toHaveBeenCalledTimes(1);
    });
  });

  // ── Acceptance: configuration guards ────────────────────────────────────────

  describe('configuration', () => {
    it('does nothing when the scheduler is disabled', async () => {
      const { scheduler, triggerSubmission } = await buildHarness({
        batches: [makeBatch({ id: 'batch-disabled' })],
        config: { 'oracle.schedulerEnabled': false },
      });

      await expect(scheduler.runSubmissionCycle()).resolves.toMatchObject({ skipped: true });
      expect(triggerSubmission).not.toHaveBeenCalled();
    });

    it('does nothing when ORACLE_ADDRESS is unset', async () => {
      const { scheduler, triggerSubmission } = await buildHarness({
        batches: [makeBatch({ id: 'batch-no-address' })],
        config: { 'oracle.address': '' },
      });

      await expect(scheduler.runSubmissionCycle()).resolves.toMatchObject({ skipped: true });
      expect(triggerSubmission).not.toHaveBeenCalled();
    });
  });

  // ── Acceptance: graceful shutdown ───────────────────────────────────────────

  describe('graceful shutdown', () => {
    it('stops the registered cron job', async () => {
      const { scheduler, cronJob } = await buildHarness();

      scheduler.onApplicationShutdown('SIGTERM');

      expect(cronJob.stop).toHaveBeenCalled();
    });

    it('survives shutdown when no cron job was registered', async () => {
      const { scheduler, module } = await buildHarness();
      const registry = module.get(SchedulerRegistry) as unknown as { getCronJob: jest.Mock };
      registry.getCronJob.mockImplementation(() => {
        throw new Error(`No cron job named ${ORACLE_SUBMISSION_CRON_NAME}`);
      });

      expect(() => scheduler.onApplicationShutdown('SIGTERM')).not.toThrow();
    });

    it('refuses to start a cycle after shutdown', async () => {
      const { scheduler, triggerSubmission } = await buildHarness({
        batches: [makeBatch({ id: 'batch-shutdown' })],
      });

      scheduler.onApplicationShutdown('SIGTERM');
      await expect(scheduler.runSubmissionCycle()).resolves.toMatchObject({ skipped: true });
      expect(triggerSubmission).not.toHaveBeenCalled();
    });

    it('stops submitting further batches once shutdown begins mid-cycle', async () => {
      // Holder, so the mock can reach the scheduler that the harness builds
      // around it: SIGTERM arrives while the first batch is being submitted.
      const ref: { scheduler?: OracleSchedulerService } = {};
      const triggerSubmission = jest.fn(async () => {
        ref.scheduler?.onApplicationShutdown('SIGTERM');
        return { id: 'submission' } as OracleSubmission;
      });

      const { scheduler } = await buildHarness({
        batches: [makeBatch({ id: 'batch-1' }), makeBatch({ id: 'batch-2' })],
        oracleService: { triggerSubmission } as unknown as Partial<OracleService>,
      });
      ref.scheduler = scheduler;

      const result = await scheduler.runSubmissionCycle();

      expect(triggerSubmission).toHaveBeenCalledTimes(1);
      expect(result.submitted).toBe(1);
    });
  });
});

// ── Acceptance: concurrent manual trigger + cron trigger ─────────────────────
//
// This suite wires the REAL OracleService against a fake query runner that
// emulates `pg_advisory_xact_lock` with an actual mutex, so the nonce
// allocation the lock protects is exercised rather than assumed.

describe('OracleSchedulerService + manual POST /oracle/trigger (advisory lock)', () => {
  /** Mutex standing in for the per-oracle Postgres advisory lock. */
  class Mutex {
    private queue: Promise<void> = Promise.resolve();

    run<T>(fn: () => Promise<T>): Promise<T> {
      const result = this.queue.then(fn);
      this.queue = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    }
  }

  interface LockTrace {
    event: 'acquire' | 'release';
    at: number;
  }

  async function buildRacingHarness() {
    const locks: Record<string, Mutex> = {};
    const lockTrace: LockTrace[] = [];
    /** Stands in for the `oracle_submissions` table. */
    const submissions: OracleSubmission[] = [];
    let sequence = 0;

    const createQueryRunner = () => {
      let releaseLock: (() => void) | null = null;
      let lockAcquired: Promise<void> | null = null;

      return {
        connect: jest.fn().mockResolvedValue(undefined),
        startTransaction: jest.fn().mockResolvedValue(undefined),
        query: jest.fn(async (sql: string, params: unknown[]) => {
          if (sql.includes('pg_advisory_xact_lock')) {
            const key = params[0] as string;
            locks[key] = locks[key] ?? new Mutex();
            // Hold the mutex until the transaction commits or rolls back,
            // exactly like a transaction-scoped advisory lock.
            lockAcquired = locks[key].run(
              () =>
                new Promise<void>((resolve) => {
                  lockTrace.push({ event: 'acquire', at: ++sequence });
                  releaseLock = () => {
                    lockTrace.push({ event: 'release', at: ++sequence });
                    resolve();
                  };
                }),
            );
            // Wait until this caller actually owns the lock.
            await new Promise<void>((resolve) => {
              const poll = () => (releaseLock ? resolve() : setImmediate(poll));
              poll();
            });
            return [];
          }

          if (sql.includes('SELECT MAX')) {
            const address = params[0] as string;
            const nonces = submissions
              .filter((s) => s.oracleAddress === address)
              .map((s) => s.nonce);
            // Yield the event loop between read and write: without the lock
            // this is exactly where two callers would read the same nonce.
            await new Promise((resolve) => setImmediate(resolve));
            return [{ max_nonce: nonces.length ? `${Math.max(...nonces)}` : null }];
          }

          return [];
        }),
        manager: {
          create: jest.fn((_entity: unknown, data: OracleSubmission) => data),
          save: jest.fn(async (_entity: unknown, data: OracleSubmission) => {
            const saved = { ...data, id: `submission-${submissions.length + 1}` };
            submissions.push(saved);
            return saved;
          }),
        },
        commitTransaction: jest.fn(async () => releaseLock?.()),
        rollbackTransaction: jest.fn(async () => releaseLock?.()),
        release: jest.fn().mockResolvedValue(undefined),
        lockAcquiredRef: () => lockAcquired,
      };
    };

    const queue = { add: jest.fn().mockResolvedValue(undefined) };
    const batch = makeBatch({ id: 'batch-raced' });
    const batchRepo = new InMemoryBatchRepo([batch]);

    const module = await Test.createTestingModule({
      providers: [
        OracleService,
        OracleSchedulerService,
        { provide: NotificationsService, useValue: { notifyOracleMissedSubmissions: jest.fn() } },
        { provide: getRepositoryToken(OracleSubmission), useValue: { find: jest.fn() } },
        {
          provide: getRepositoryToken(SensorReading),
          useValue: { createQueryBuilder: jest.fn() },
        },
        { provide: getQueueToken('oracle-submit'), useValue: queue },
        { provide: DataSource, useValue: { createQueryRunner } },
        { provide: StellarService, useValue: {} },
        {
          provide: SchedulerRegistry,
          useValue: { getCronJob: jest.fn(() => ({ stop: jest.fn() })) },
        },
        {
          provide: getRepositoryToken(Project),
          useValue: {
            find: jest.fn(async () => [makeProject('project-active', ProjectStatus.ACTIVE)]),
          },
        },
        { provide: getRepositoryToken(ReadingBatch), useValue: batchRepo },
        { provide: getRepositoryToken(OracleScheduleState), useValue: { upsert: jest.fn() } },
        { provide: getRepositoryToken(GovernanceConfig), useValue: { findOne: jest.fn() } },
        { provide: CreditScoringService, useValue: { calculate: jest.fn() } },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, fallback?: unknown) => {
              const values: Record<string, unknown> = {
                'oracle.schedulerEnabled': true,
                'oracle.address': ORACLE_ADDRESS,
                'oracle.submissionIntervalCron': '0 * * * *',
              };
              return key in values ? values[key] : fallback;
            }),
          },
        },
      ],
    }).compile();

    const oracleService = module.get(OracleService);
    jest.spyOn(oracleService, 'aggregateReadingsForBatch').mockResolvedValue(AGGREGATE);

    return {
      scheduler: module.get(OracleSchedulerService),
      oracleService,
      submissions,
      queue,
      lockTrace,
      batchRepo,
    };
  }

  it('serialises a manual trigger racing the cron cycle: unique, gapless nonces', async () => {
    const { scheduler, oracleService, submissions, queue, lockTrace } = await buildRacingHarness();

    // Fire both at once, the way an admin calling POST /oracle/trigger during
    // an hourly cycle would.
    await Promise.all([
      scheduler.runSubmissionCycle(),
      oracleService.triggerSubmission({
        projectId: 'project-active',
        oracleAddress: ORACLE_ADDRESS,
        readings: { ph: 7 },
      }),
    ]);

    const nonces = submissions.map((s) => s.nonce).sort((a, b) => a - b);
    expect(submissions).toHaveLength(2);
    expect(nonces).toEqual([1, 2]);
    expect(new Set(nonces).size).toBe(2);
    expect(queue.add).toHaveBeenCalledTimes(2);

    // The lock was genuinely exclusive: acquire/release strictly alternate.
    expect(lockTrace.map((entry) => entry.event)).toEqual([
      'acquire',
      'release',
      'acquire',
      'release',
    ]);
  });

  it('leaves the raced batch claimed exactly once', async () => {
    const { scheduler, batchRepo } = await buildRacingHarness();

    await Promise.all([scheduler.runSubmissionCycle(), scheduler.runSubmissionCycle()]);

    const submittedBatches = batchRepo.rows.filter((b) => b.status === BatchStatus.SUBMITTED);
    expect(submittedBatches).toHaveLength(1);
  });
});
