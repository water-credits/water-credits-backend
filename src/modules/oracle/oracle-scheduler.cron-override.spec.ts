import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ScheduleModule, SchedulerRegistry } from '@nestjs/schedule';
import { getRepositoryToken } from '@nestjs/typeorm';
import { OracleService } from './oracle.service';
import { OracleScheduleState } from './entities/oracle-schedule-state.entity';
import { Project } from '../projects/entities/project.entity';
import { ReadingBatch } from '../sensors/entities/reading-batch.entity';

/**
 * Acceptance: ORACLE_SUBMISSION_INTERVAL_CRON overrides the schedule expression.
 *
 * @Cron() evaluates its expression when the class is defined, so the override
 * has to be in the environment before the service module is loaded — exactly as
 * it is for a real process started with the variable set.  This file therefore
 * sets the variable and then `require`s the service, which runs after the
 * `import` statements above.  It lives in its own spec file because Jest gives
 * each file a fresh module registry.
 */
const OVERRIDE_CRON = '*/5 * * * *';
process.env.ORACLE_SUBMISSION_INTERVAL_CRON = OVERRIDE_CRON;

/* eslint-disable @typescript-eslint/no-require-imports */
const scheduleModule =
  require('./oracle-scheduler.service') as typeof import('./oracle-scheduler.service');
/* eslint-enable @typescript-eslint/no-require-imports */
const { OracleSchedulerService, ORACLE_SUBMISSION_CRON_NAME } = scheduleModule;

describe('ORACLE_SUBMISSION_INTERVAL_CRON override', () => {
  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterAll(() => {
    jest.restoreAllMocks();
    delete process.env.ORACLE_SUBMISSION_INTERVAL_CRON;
  });

  it('registers the cron job with the operator-supplied expression', async () => {
    const moduleRef = await Test.createTestingModule({
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
              if (key === 'oracle.submissionIntervalCron') {
                return OVERRIDE_CRON;
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

    const job = moduleRef.get(SchedulerRegistry).getCronJob(ORACLE_SUBMISSION_CRON_NAME);
    expect(job.cronTime.source).toBe(OVERRIDE_CRON);
    // Sanity: this is a five-minute cadence, not the hourly default.
    expect(job.cronTime.source).not.toBe('0 * * * *');

    await moduleRef.close();
  });
});
