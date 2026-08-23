import { INestApplication, Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { getQueueToken } from '@nestjs/bull';
import { DataSource } from 'typeorm';
import { HealthController } from './health.controller';
import { HealthService, HealthReport } from './health.service';
import { StellarClient } from '../stellar/stellar.client';
import { OracleService } from '../oracle/oracle.service';
import { OracleSchedulerService } from '../oracle/oracle-scheduler.service';
import { OracleSubmission } from '../oracle/entities/oracle-submission.entity';
import {
  GLOBAL_SCHEDULE_SCOPE,
  OracleScheduleState,
} from '../oracle/entities/oracle-schedule-state.entity';
import { Project, ProjectStatus } from '../projects/entities/project.entity';
import {
  BATCH_WINDOW_MS,
  BatchStatus,
  ReadingBatch,
} from '../sensors/entities/reading-batch.entity';
import { SensorReading } from '../sensors/entities/sensor-reading.entity';
import { StellarService } from '../stellar/stellar.service';
import { IndexerService } from '../indexer/indexer.service';
import { RedisService } from '../auth/redis.service';
import { GovernanceConfig } from '../governance/entities/governance-config.entity';
import { CreditScoringService } from '../oracle/credit-scoring.service';

/**
 * Outside-in proof for Issue #44.
 *
 * Boots a real HTTP server, runs a real submission cycle through the real
 * OracleSchedulerService and OracleService, then hits `GET /health` over the
 * wire and checks that the response reflects it:
 *
 *   - `checks.oracle.last_scheduled_at` reports oracle freshness
 *   - `checks.queues['oracle-submit'].waiting` counts the scheduler-added job
 */
describe('GET /health (oracle freshness + scheduler-added jobs)', () => {
  const ORACLE_ADDRESS = 'GORACLEHEALTHTEST000000000000000000000000000000000000AAA';

  /** Stands in for the Bull queue: `add` from the scheduler, counts for health. */
  class FakeQueue {
    jobs: unknown[] = [];
    add = jest.fn(async (_name: string, data: unknown) => {
      this.jobs.push(data);
      return { id: `${this.jobs.length}` };
    });
    getWaitingCount = jest.fn(async () => this.jobs.length);
    getActiveCount = jest.fn(async () => 0);
    getFailedCount = jest.fn(async () => 0);
    client = Promise.resolve({ ping: async () => 'PONG' });
  }

  /** Stands in for the `oracle_schedule_state` table. */
  class FakeScheduleStateRepo {
    rows = new Map<string, OracleScheduleState>();

    upsert = jest.fn(async (entity: Partial<OracleScheduleState>) => {
      this.rows.set(
        entity.scopeId as string,
        {
          ...(this.rows.get(entity.scopeId as string) ?? ({} as OracleScheduleState)),
          ...entity,
        } as OracleScheduleState,
      );
      return { identifiers: [] };
    });

    findOne = jest.fn(async (options: { where: { scopeId: string } }) => {
      return this.rows.get(options.where.scopeId) ?? null;
    });
  }

  let app: INestApplication;
  let baseUrl: string;
  let queue: FakeQueue;
  let scheduleStateRepo: FakeScheduleStateRepo;
  let scheduler: OracleSchedulerService;
  let batch: ReadingBatch;

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);

    queue = new FakeQueue();
    scheduleStateRepo = new FakeScheduleStateRepo();

    batch = {
      id: 'batch-health',
      projectId: 'project-health',
      status: BatchStatus.PENDING,
      readingCount: 4,
      creditsGenerated: null,
      submittedAt: null,
      confirmedAt: null,
      createdAt: new Date(Date.now() - BATCH_WINDOW_MS - 60_000),
      updatedAt: new Date(),
    } as ReadingBatch;

    const batchRepo = {
      find: jest.fn(async () => (batch.status === BatchStatus.PENDING ? [batch] : [])),
      update: jest.fn(async (criteria: { status: BatchStatus }, partial: Partial<ReadingBatch>) => {
        if (batch.status !== criteria.status) {
          return { affected: 0 };
        }
        Object.assign(batch, partial);
        return { affected: 1 };
      }),
    };

    // Minimal query runner: the nonce allocation OracleService.triggerSubmission
    // performs, without a live Postgres.
    const createQueryRunner = () => ({
      connect: jest.fn().mockResolvedValue(undefined),
      startTransaction: jest.fn().mockResolvedValue(undefined),
      query: jest.fn(async (sql: string) =>
        sql.includes('SELECT MAX') ? [{ max_nonce: null }] : [],
      ),
      manager: {
        create: jest.fn((_entity: unknown, data: unknown) => data),
        save: jest.fn(async (_entity: unknown, data: object) => ({ ...data, id: 'submission-1' })),
      },
      commitTransaction: jest.fn().mockResolvedValue(undefined),
      rollbackTransaction: jest.fn().mockResolvedValue(undefined),
      release: jest.fn().mockResolvedValue(undefined),
    });

    const dataSource = {
      createQueryRunner,
      query: jest.fn(async () => [{ '?column?': 1 }]),
    };

    const configValues: Record<string, unknown> = {
      'oracle.schedulerEnabled': true,
      'oracle.address': ORACLE_ADDRESS,
      'oracle.submissionIntervalCron': '0 * * * *',
      'oracle.stalenessThresholdSeconds': 7200,
    };

    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        HealthService,
        OracleService,
        OracleSchedulerService,
        { provide: DataSource, useValue: dataSource },
        { provide: getDataSourceToken(), useValue: dataSource },
        { provide: getQueueToken('oracle-submit'), useValue: queue },
        { provide: getQueueToken('sensor-ingestion'), useValue: new FakeQueue() },
        { provide: getQueueToken('retirements'), useValue: new FakeQueue() },
        { provide: getRepositoryToken(OracleScheduleState), useValue: scheduleStateRepo },
        { provide: getRepositoryToken(OracleSubmission), useValue: { find: jest.fn() } },
        { provide: getRepositoryToken(SensorReading), useValue: { createQueryBuilder: jest.fn() } },
        { provide: getRepositoryToken(ReadingBatch), useValue: batchRepo },
        {
          provide: getRepositoryToken(Project),
          useValue: {
            find: jest.fn(async () => [
              { id: 'project-health', status: ProjectStatus.ACTIVE } as Project,
            ]),
          },
        },
        { provide: StellarService, useValue: {} },
        { provide: getRepositoryToken(GovernanceConfig), useValue: { findOne: jest.fn() } },
        { provide: CreditScoringService, useValue: { calculate: jest.fn() } },
        {
          provide: SchedulerRegistry,
          useValue: { getCronJob: jest.fn(() => ({ stop: jest.fn() })) },
        },
        {
          provide: StellarClient,
          useValue: {
            getServer: () => ({ getLatestLedger: async () => ({ sequence: 4242 }) }),
            isSigningReady: () => true,
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, fallback?: unknown) =>
              key in configValues ? configValues[key] : fallback,
            ),
          },
        },
        {
          provide: IndexerService,
          useValue: {
            getIndexerStatus: jest.fn().mockResolvedValue({
              status: 'ok',
              lastIndexedLedger: 4241,
              chainTipLedger: 4242,
              lag: 1,
            }),
            onModuleInit: jest.fn(),
            onModuleDestroy: jest.fn(),
          },
        },
        {
          provide: RedisService,
          useValue: { ping: jest.fn().mockResolvedValue(undefined) },
        },
      ],
    }).compile();

    scheduler = moduleRef.get(OracleSchedulerService);
    jest.spyOn(moduleRef.get(OracleService), 'aggregateReadingsForBatch').mockResolvedValue({
      medianPh: 7,
      medianTurbidity: 1,
      medianDissolvedOxygen: 9,
      medianFlowRate: 20,
      medianNitrogen: 0.2,
      medianPhosphorus: 0.1,
      medianTemperature: 18,
      oracleCount: 4,
      startTime: new Date(),
      endTime: new Date(),
    });

    app = moduleRef.createNestApplication();
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
  }, 30000);

  afterAll(async () => {
    await app?.close();
    jest.restoreAllMocks();
  });

  async function getHealth(): Promise<{ status: number; body: HealthReport }> {
    const res = await fetch(`${baseUrl}/health`);
    return { status: res.status, body: (await res.json()) as HealthReport };
  }

  it('reports the oracle as never-run before the first cycle', async () => {
    const { status, body } = await getHealth();

    expect(status).toBe(200);
    expect(body.checks.oracle).toMatchObject({
      status: 'ok',
      enabled: true,
      cron: '0 * * * *',
      last_scheduled_at: null,
      detail: 'no submission cycle has run yet',
    });
    expect(body.checks.queues['oracle-submit'].waiting).toBe(0);
  });

  it('reports oracle freshness and the scheduler-added job after a cycle', async () => {
    const result = await scheduler.runSubmissionCycle();
    expect(result).toMatchObject({ projectsScanned: 1, submitted: 1, failed: 0 });

    const { status, body } = await getHealth();

    expect(status).toBe(200);
    expect(body.status).toBe('ok');

    // Acceptance: GET /health reports oracle freshness.
    expect(body.checks.oracle.last_scheduled_at).not.toBeNull();
    expect(new Date(body.checks.oracle.last_scheduled_at as string).getTime()).toBeGreaterThan(
      Date.now() - 60_000,
    );
    expect(body.checks.oracle.staleness_s).toBeLessThan(60);
    expect(body.checks.oracle.last_submission_count).toBe(1);
    expect(body.checks.oracle.status).toBe('ok');

    // Acceptance: queues['oracle-submit'].waiting reflects scheduler-added jobs.
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(queue.add.mock.calls[0][0]).toBe('oracle-submit-job');
    expect(body.checks.queues['oracle-submit'].waiting).toBe(1);

    // The batch was claimed, so a second cycle adds nothing further.
    expect(batch.status).toBe(BatchStatus.SUBMITTED);
    await scheduler.runSubmissionCycle();
    const second = await getHealth();
    expect(second.body.checks.queues['oracle-submit'].waiting).toBe(1);
  });

  it('degrades — but still answers 200 — when the last cycle is stale', async () => {
    await scheduleStateRepo.upsert({
      scopeId: GLOBAL_SCHEDULE_SCOPE,
      lastScheduledAt: new Date(Date.now() - 10 * 3600 * 1000),
      lastSubmissionCount: 0,
    });

    const { status, body } = await getHealth();

    expect(status).toBe(200);
    expect(body.checks.oracle.status).toBe('degraded');
    expect(body.checks.oracle.detail).toMatch(/threshold 7200s/);
    expect(body.status).toBe('degraded');
  });
});
