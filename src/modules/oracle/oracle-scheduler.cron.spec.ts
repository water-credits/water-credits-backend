import { Logger } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ScheduleModule, SchedulerRegistry } from '@nestjs/schedule';
import { getRepositoryToken } from '@nestjs/typeorm';
import {
  ORACLE_SUBMISSION_CRON_NAME,
  OracleSchedulerService,
  resolveCronExpression,
} from './oracle-scheduler.service';
import { OracleService } from './oracle.service';
import { OracleScheduleState } from './entities/oracle-schedule-state.entity';
import { Project } from '../projects/entities/project.entity';
import { ReadingBatch } from '../sensors/entities/reading-batch.entity';
import { DEFAULT_ORACLE_SUBMISSION_CRON } from '../../config/oracle.config';

/**
 * Proves the @Cron decorator is genuinely wired into the running scheduler:
 * the job exists under its registered name, carries the hourly expression the
 * README specifies, invokes the submission cycle when it fires, and stops on
 * application shutdown.
 *
 * The ORACLE_SUBMISSION_INTERVAL_CRON override is proved end-to-end in
 * oracle-scheduler.cron-override.spec.ts, which sets the variable before the
 * service module is first loaded.
 */
describe('OracleSchedulerService @Cron registration', () => {
  let moduleRef: TestingModule;
  let scheduler: OracleSchedulerService;

  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger, 'warn').mockImplementation(() => undefined);
  });

  afterAll(() => jest.restoreAllMocks());

  beforeEach(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [ScheduleModule.forRoot()],
      providers: [
        OracleSchedulerService,
        {
          provide: OracleService,
          useValue: { aggregateReadingsForBatch: jest.fn(), triggerSubmission: jest.fn() },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, fallback?: unknown) => {
              if (key === 'oracle.schedulerEnabled') {
                return true;
              }
              if (key === 'oracle.address') {
                return 'GTESTORACLEADDRESS';
              }
              return fallback;
            }),
          },
        },
        { provide: getRepositoryToken(Project), useValue: { find: jest.fn(async () => []) } },
        { provide: getRepositoryToken(ReadingBatch), useValue: { find: jest.fn(async () => []) } },
        {
          provide: getRepositoryToken(OracleScheduleState),
          useValue: { upsert: jest.fn(async () => undefined) },
        },
      ],
    }).compile();

    await moduleRef.init();
    scheduler = moduleRef.get(OracleSchedulerService);
  });

  it('registers the hourly cron job under its published name', () => {
    const registry = moduleRef.get(SchedulerRegistry);

    expect(ORACLE_SUBMISSION_CRON_NAME).toBe('oracle-submission-cycle');
    expect(registry.doesExist('cron', ORACLE_SUBMISSION_CRON_NAME)).toBe(true);

    const job = registry.getCronJob(ORACLE_SUBMISSION_CRON_NAME);
    expect(job.cronTime.source).toBe(DEFAULT_ORACLE_SUBMISSION_CRON);
    expect(job.isActive).toBe(true);
  });

  it('runs a submission cycle when the cron fires', async () => {
    const cycle = jest
      .spyOn(scheduler, 'runSubmissionCycle')
      .mockResolvedValue({ projectsScanned: 0, submitted: 0, failed: 0, skipped: false });

    await moduleRef.get(SchedulerRegistry).getCronJob(ORACLE_SUBMISSION_CRON_NAME).fireOnTick();

    expect(cycle).toHaveBeenCalledTimes(1);
  });

  it('stops the cron job on application shutdown', async () => {
    const job = moduleRef.get(SchedulerRegistry).getCronJob(ORACLE_SUBMISSION_CRON_NAME);
    expect(job.isActive).toBe(true);

    await moduleRef.close();

    expect(job.isActive).toBe(false);
  });

  afterEach(async () => {
    await moduleRef.close();
  });
});

describe('resolveCronExpression', () => {
  const ORIGINAL = process.env.ORACLE_SUBMISSION_INTERVAL_CRON;

  beforeAll(() => {
    jest.spyOn(Logger, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    if (ORIGINAL === undefined) {
      delete process.env.ORACLE_SUBMISSION_INTERVAL_CRON;
    } else {
      process.env.ORACLE_SUBMISSION_INTERVAL_CRON = ORIGINAL;
    }
  });

  afterAll(() => jest.restoreAllMocks());

  it('defaults to hourly when unset', () => {
    delete process.env.ORACLE_SUBMISSION_INTERVAL_CRON;
    expect(resolveCronExpression()).toBe(DEFAULT_ORACLE_SUBMISSION_CRON);
  });

  it('defaults to hourly when blank', () => {
    process.env.ORACLE_SUBMISSION_INTERVAL_CRON = '   ';
    expect(resolveCronExpression()).toBe(DEFAULT_ORACLE_SUBMISSION_CRON);
  });

  it('accepts a 5-field override', () => {
    process.env.ORACLE_SUBMISSION_INTERVAL_CRON = '*/5 * * * *';
    expect(resolveCronExpression()).toBe('*/5 * * * *');
  });

  it('accepts a 6-field override with seconds', () => {
    process.env.ORACLE_SUBMISSION_INTERVAL_CRON = '30 */2 * * * *';
    expect(resolveCronExpression()).toBe('30 */2 * * * *');
  });

  it('falls back to hourly rather than crashing on a malformed override', () => {
    process.env.ORACLE_SUBMISSION_INTERVAL_CRON = 'every-five-minutes';
    expect(resolveCronExpression()).toBe(DEFAULT_ORACLE_SUBMISSION_CRON);
  });
});
