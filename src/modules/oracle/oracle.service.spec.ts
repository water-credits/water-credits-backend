import { Test, TestingModule } from '@nestjs/testing';
import { Logger, NotFoundException } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { getQueueToken } from '@nestjs/bull';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { OracleService, AggregatedReading } from './oracle.service';
import { OracleSubmission, SubmissionStatus } from './entities/oracle-submission.entity';
import { StellarService } from '../stellar/stellar.service';
import { SensorReading } from '../sensors/entities/sensor-reading.entity';
import { Project } from '../projects/entities/project.entity';
import { GovernanceConfig } from '../governance/entities/governance-config.entity';
import { ReadingBatch } from '../sensors/entities/reading-batch.entity';
import { CreditScoringService } from './credit-scoring.service';

// ── Typed mock factory ────────────────────────────────────────────────────────

type QueryRunnerMock = {
  connect: jest.Mock;
  startTransaction: jest.Mock;
  query: jest.Mock;
  manager: { create: jest.Mock; save: jest.Mock };
  commitTransaction: jest.Mock;
  rollbackTransaction: jest.Mock;
  release: jest.Mock;
};

function makeQueryRunner(): QueryRunnerMock {
  return {
    connect: jest.fn().mockResolvedValue(undefined),
    startTransaction: jest.fn().mockResolvedValue(undefined),
    query: jest.fn().mockImplementation(async (sql: string, _params?: unknown[]) => {
      // Return void for advisory lock, nonce result for MAX query.
      if (sql.includes('pg_advisory_xact_lock')) {
        return [];
      }
      if (sql.includes('SELECT MAX')) {
        return [{ max_nonce: null }];
      }
      return [];
    }),
    manager: {
      create: jest.fn().mockImplementation((_Entity: unknown, data: unknown) => data),
      save: jest
        .fn()
        .mockImplementation((_Entity: unknown, entity: unknown) =>
          Promise.resolve({ ...(entity as Record<string, unknown>), id: 'sub-uuid-1' }),
        ),
    },
    commitTransaction: jest.fn().mockResolvedValue(undefined),
    rollbackTransaction: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined),
  };
}

type SubmissionRepoMock = {
  find: jest.Mock;
  findOne: jest.Mock;
  count: jest.Mock;
  create: jest.Mock;
  save: jest.Mock;
  createQueryBuilder: jest.Mock;
};

function makeSubmissionRepo(): SubmissionRepoMock {
  return {
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
    count: jest.fn().mockResolvedValue(0),
    create: jest.fn(),
    save: jest.fn(),
    createQueryBuilder: jest.fn(() => ({
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
    })),
  };
}

type ReadingQbMock = {
  select: jest.Mock;
  addSelect: jest.Mock;
  where: jest.Mock;
  andWhere: jest.Mock;
  getRawOne: jest.Mock;
};

type ReadingRepoMock = {
  createQueryBuilder: jest.Mock;
};

function zeroAggregationRow() {
  return {
    medianPh: null,
    medianTurbidity: null,
    medianDissolvedOxygen: null,
    medianFlowRate: null,
    medianNitrogen: null,
    medianPhosphorus: null,
    medianTemperature: null,
    oracleCount: '0',
    startTime: null,
    endTime: null,
  };
}

function makeReadingQb(): ReadingQbMock {
  return {
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    getRawOne: jest.fn().mockResolvedValue(zeroAggregationRow()),
  };
}

function makeReadingRepo(): ReadingRepoMock {
  return {
    createQueryBuilder: jest.fn(),
  };
}

function makeSubmission(overrides: Partial<OracleSubmission> = {}): OracleSubmission {
  return {
    id: 'sub-1',
    projectId: 'proj-1',
    oracleAddress: 'GABC123',
    nonce: 1,
    txHash: '',
    status: SubmissionStatus.CONFIRMED,
    readingsSnapshot: { dissolvedOxygen: 6.8 },
    result: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    project: undefined as never,
    ...overrides,
  };
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('OracleService', () => {
  let service: OracleService;
  let queryRunner: QueryRunnerMock;
  let submissionRepo: SubmissionRepoMock;
  let oracleQueue: { add: jest.Mock };
  let dataSource: { createQueryRunner: jest.Mock };
  let stellarService: { getOracleNonce: jest.Mock; submitReading: jest.Mock };
  let readingRepo: ReadingRepoMock;
  let readingQb: ReadingQbMock;

  beforeEach(async () => {
    queryRunner = makeQueryRunner();
    submissionRepo = makeSubmissionRepo();
    oracleQueue = { add: jest.fn().mockResolvedValue({ id: 'job-1' }) };
    dataSource = { createQueryRunner: jest.fn().mockReturnValue(queryRunner) };
    stellarService = { getOracleNonce: jest.fn(), submitReading: jest.fn() };
    readingQb = makeReadingQb();
    readingRepo = makeReadingRepo();
    readingRepo.createQueryBuilder.mockReturnValue(readingQb);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OracleService,
        { provide: getRepositoryToken(OracleSubmission), useValue: submissionRepo },
        { provide: getRepositoryToken(SensorReading), useValue: readingRepo },
        { provide: getQueueToken('oracle-submit'), useValue: oracleQueue },
        { provide: ConfigService, useValue: { get: jest.fn() } },
        { provide: DataSource, useValue: dataSource },
        { provide: StellarService, useValue: stellarService },
        { provide: getRepositoryToken(Project), useValue: { findOne: jest.fn() } },
        { provide: getRepositoryToken(GovernanceConfig), useValue: { findOne: jest.fn() } },
        {
          provide: getRepositoryToken(ReadingBatch),
          useValue: { findOne: jest.fn(), save: jest.fn() },
        },
        { provide: CreditScoringService, useValue: { calculate: jest.fn() } },
      ],
    }).compile();

    service = module.get<OracleService>(OracleService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  // ── triggerSubmission — happy path ───────────────────────────────────────

  describe('triggerSubmission — happy path', () => {
    it('creates a submission record and enqueues a job when max_nonce is null (first submission)', async () => {
      queryRunner.query.mockResolvedValue([{ max_nonce: null }]);

      const result = await service.triggerSubmission({
        projectId: 'proj-1',
        oracleAddress: 'GABC',
        readings: { ph: 7.2 },
      });

      expect(result).toBeDefined();
      expect(queryRunner.commitTransaction).toHaveBeenCalled();
      expect(oracleQueue.add).toHaveBeenCalledWith(
        'oracle-submit-job',
        expect.objectContaining({ projectId: 'proj-1', nonce: 1 }),
        expect.any(Object),
      );
    });

    it('increments nonce correctly when a previous submission exists (max_nonce = 5)', async () => {
      queryRunner.query.mockResolvedValue([{ max_nonce: '5' }]);

      await service.triggerSubmission({
        projectId: 'proj-1',
        oracleAddress: 'GABC',
      });

      expect(oracleQueue.add).toHaveBeenCalledWith(
        'oracle-submit-job',
        expect.objectContaining({ nonce: 6 }),
        expect.any(Object),
      );
    });

    it('includes the submissionId and oracleAddress in the queued job payload', async () => {
      queryRunner.query.mockResolvedValue([{ max_nonce: '0' }]);

      await service.triggerSubmission({
        projectId: 'proj-abc',
        oracleAddress: 'GORACLE',
        readings: {},
      });

      expect(oracleQueue.add).toHaveBeenCalledWith(
        'oracle-submit-job',
        expect.objectContaining({
          submissionId: 'sub-uuid-1',
          projectId: 'proj-abc',
          oracleAddress: 'GORACLE',
          nonce: 1,
        }),
        expect.any(Object),
      );
    });

    it('returns the saved submission object from the transaction', async () => {
      queryRunner.query.mockResolvedValue([{ max_nonce: '2' }]);
      queryRunner.manager.save.mockResolvedValue({
        id: 'sub-uuid-99',
        nonce: 3,
        status: SubmissionStatus.PENDING,
        projectId: 'proj-1',
        oracleAddress: 'GABC',
        readingsSnapshot: {},
      });

      const result = await service.triggerSubmission({
        projectId: 'proj-1',
        oracleAddress: 'GABC',
      });

      expect(result.id).toBe('sub-uuid-99');
      expect(result.nonce).toBe(3);
    });
  });

  // ── triggerSubmission — nonce uniqueness / error handling ────────────────

  describe('triggerSubmission — nonce collision and error handling', () => {
    it('rolls back the transaction and re-throws when a nonce uniqueness violation occurs', async () => {
      const uniqueViolation = new Error(
        'duplicate key value violates unique constraint "UQ_oracle_submissions"',
      );
      queryRunner.manager.save.mockRejectedValue(uniqueViolation);

      await expect(
        service.triggerSubmission({ projectId: 'proj-1', oracleAddress: 'GABC' }),
      ).rejects.toThrow('duplicate key value');

      expect(queryRunner.rollbackTransaction).toHaveBeenCalled();
      expect(queryRunner.release).toHaveBeenCalled();
      // No job should be enqueued for a failed save.
      expect(oracleQueue.add).not.toHaveBeenCalled();
    });

    it('always releases the query runner even when rollback itself throws', async () => {
      queryRunner.manager.save.mockRejectedValue(new Error('save error'));
      queryRunner.rollbackTransaction.mockRejectedValue(new Error('rollback error'));

      await expect(
        service.triggerSubmission({ projectId: 'p', oracleAddress: 'G' }),
      ).rejects.toThrow();

      expect(queryRunner.release).toHaveBeenCalled();
    });

    it('simulated concurrent race: first call succeeds, second receives a uniqueness error', async () => {
      // Both callers read the same max_nonce so they each compute nonce = 1.
      // The DB unique constraint fires on the second insert.
      queryRunner.query.mockResolvedValue([{ max_nonce: null }]);

      let saveCallCount = 0;
      queryRunner.manager.save.mockImplementation(() => {
        saveCallCount += 1;
        if (saveCallCount === 1) {
          return Promise.resolve({ id: 'sub-1', nonce: 1, status: SubmissionStatus.PENDING });
        }
        return Promise.reject(
          new Error('duplicate key value violates unique constraint "UQ_oracle_submissions"'),
        );
      });

      const [first, second] = await Promise.allSettled([
        service.triggerSubmission({ projectId: 'proj-1', oracleAddress: 'GABC' }),
        service.triggerSubmission({ projectId: 'proj-1', oracleAddress: 'GABC' }),
      ]);

      const successes = [first, second].filter((r) => r.status === 'fulfilled');
      const failures = [first, second].filter((r) => r.status === 'rejected');

      expect(successes).toHaveLength(1);
      expect(failures).toHaveLength(1);
      expect((failures[0] as PromiseRejectedResult).reason.message).toMatch(/duplicate key/);
    });
  });

  // ── getStatus ─────────────────────────────────────────────────────────────

  describe('getStatus', () => {
    it('returns counts from the repository', async () => {
      submissionRepo.count
        .mockResolvedValueOnce(10) // total
        .mockResolvedValueOnce(2) // pending
        .mockResolvedValueOnce(7) // confirmed
        .mockResolvedValueOnce(1); // failed
      submissionRepo.findOne.mockResolvedValue(null);

      const status = await service.getStatus();

      expect(status.totalSubmissions).toBe(10);
      expect(status.pending).toBe(2);
      expect(status.confirmed).toBe(7);
      expect(status.failed).toBe(1);
      expect(status.lastSubmission).toBeNull();
    });

    it('includes the most recent submission in the response', async () => {
      const lastSub: Partial<OracleSubmission> = {
        id: 'sub-last',
        status: SubmissionStatus.CONFIRMED,
        nonce: 99,
      };
      submissionRepo.count.mockResolvedValue(5);
      submissionRepo.findOne.mockResolvedValue(lastSub as OracleSubmission);

      const status = await service.getStatus();

      expect(status.lastSubmission).toEqual(lastSub);
    });
  });

  // ── getSubmissions ───────────────────────────────────────────────────────

  describe('getSubmissions', () => {
    function makeQb() {
      const qb = {
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
      };
      submissionRepo.createQueryBuilder.mockReturnValue(qb);
      return qb;
    }

    it('returns paginated submissions with no filters applied', async () => {
      const subs = [{ id: 'sub-1' }, { id: 'sub-2' }] as OracleSubmission[];
      const qb = makeQb();
      qb.getManyAndCount.mockResolvedValue([subs, 2]);

      const result = await service.getSubmissions({
        skip: 0,
        limit: 20,
        page: 1,
      } as never);

      expect(result.data).toHaveLength(2);
      expect(result.total).toBe(2);
      expect(qb.andWhere).not.toHaveBeenCalled();
    });

    it('applies projectId filter when provided', async () => {
      const qb = makeQb();

      await service.getSubmissions({
        projectId: 'proj-1',
        skip: 0,
        limit: 20,
        page: 1,
      } as never);

      expect(qb.andWhere).toHaveBeenCalledWith(
        expect.stringContaining('project_id'),
        expect.objectContaining({ projectId: 'proj-1' }),
      );
    });

    it('applies oracleAddress filter when provided', async () => {
      const qb = makeQb();

      await service.getSubmissions({
        oracleAddress: 'GORACLE',
        skip: 0,
        limit: 20,
        page: 1,
      } as never);

      expect(qb.andWhere).toHaveBeenCalledWith(
        expect.stringContaining('oracle_address'),
        expect.objectContaining({ oracleAddress: 'GORACLE' }),
      );
    });

    it('applies status filter when provided', async () => {
      const qb = makeQb();

      await service.getSubmissions({
        status: SubmissionStatus.CONFIRMED,
        skip: 0,
        limit: 20,
        page: 1,
      } as never);

      expect(qb.andWhere).toHaveBeenCalledWith(
        expect.stringContaining('status'),
        expect.objectContaining({ status: SubmissionStatus.CONFIRMED }),
      );
    });

    it('applies startDate and endDate filters when provided', async () => {
      const qb = makeQb();

      await service.getSubmissions({
        startDate: '2026-01-01',
        endDate: '2026-12-31',
        skip: 0,
        limit: 20,
        page: 1,
      } as never);

      expect(qb.andWhere).toHaveBeenCalledWith(
        expect.stringContaining('created_at >='),
        expect.objectContaining({ startDate: '2026-01-01' }),
      );
      expect(qb.andWhere).toHaveBeenCalledWith(
        expect.stringContaining('created_at <='),
        expect.objectContaining({ endDate: '2026-12-31' }),
      );
    });
  });

  // ── getPendingSubmissions ─────────────────────────────────────────────────

  describe('getPendingSubmissions', () => {
    it('returns only PENDING submissions ordered by createdAt ASC', async () => {
      const pending = [{ id: 'sub-p1', status: SubmissionStatus.PENDING }] as OracleSubmission[];
      submissionRepo.find.mockResolvedValue(pending);

      const result = await service.getPendingSubmissions();

      expect(result).toEqual(pending);
      expect(submissionRepo.find).toHaveBeenCalledWith({
        where: { status: SubmissionStatus.PENDING },
        order: { createdAt: 'ASC' },
      });
    });
  });

  describe('aggregateReadings — median aggregation over sensor_readings', () => {
    function makeReading(overrides: Partial<SensorReading> = {}): SensorReading {
      return {
        id: 'reading-1',
        deviceId: 'dev-1',
        projectId: 'proj-1',
        timestamp: new Date('2026-01-01T00:00:00Z'),
        ph: 7.0,
        turbidity: 10,
        dissolvedOxygen: 8.0,
        flowRate: 1.5,
        nitrogen: 2.0,
        phosphorus: 0.1,
        temperature: 18.0,
        signature: 'sig',
        isVerified: true,
        batchId: null,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        ...overrides,
      } as SensorReading;
    }

    it('returns the correct median for every parameter from 5 verified sensor readings', async () => {
      const readings = [
        makeReading({
          ph: 6.0,
          turbidity: 10,
          dissolvedOxygen: 6.0,
          flowRate: 1.0,
          nitrogen: 1.0,
          phosphorus: 0.1,
          temperature: 15.0,
        }),
        makeReading({
          ph: 7.0,
          turbidity: 20,
          dissolvedOxygen: 7.0,
          flowRate: 2.0,
          nitrogen: 1.5,
          phosphorus: 0.2,
          temperature: 16.0,
        }),
        makeReading({
          ph: 8.0,
          turbidity: 30,
          dissolvedOxygen: 8.0,
          flowRate: 3.0,
          nitrogen: 2.0,
          phosphorus: 0.3,
          temperature: 17.0,
        }),
        makeReading({
          ph: 7.5,
          turbidity: 40,
          dissolvedOxygen: 9.0,
          flowRate: 4.0,
          nitrogen: 2.5,
          phosphorus: 0.4,
          temperature: 18.0,
        }),
        makeReading({
          ph: 8.5,
          turbidity: 50,
          dissolvedOxygen: 10.0,
          flowRate: 5.0,
          nitrogen: 3.0,
          phosphorus: 0.5,
          temperature: 19.0,
        }),
      ];

      // Medians of the 5 readings above:
      // ph: [6.0, 7.0, 7.5, 8.0, 8.5] → 7.5
      // turbidity: [10, 20, 30, 40, 50] → 30
      // dissolvedOxygen: [6, 7, 8, 9, 10] → 8
      // flowRate: [1, 2, 3, 4, 5] → 3
      // nitrogen: [1.0, 1.5, 2.0, 2.5, 3.0] → 2
      // phosphorus: [0.1, 0.2, 0.3, 0.4, 0.5] → 0.3
      // temperature: [15, 16, 17, 18, 19] → 17
      readingQb.getRawOne.mockResolvedValue({
        medianPh: '7.5',
        medianTurbidity: '30',
        medianDissolvedOxygen: '8',
        medianFlowRate: '3',
        medianNitrogen: '2',
        medianPhosphorus: '0.3',
        medianTemperature: '17',
        oracleCount: '5',
        startTime: readings[0].timestamp,
        endTime: readings[4].timestamp,
      });

      const result: AggregatedReading = await service.aggregateReadings('proj-1');

      expect(result.medianPh).toBe(7.5);
      expect(result.medianTurbidity).toBe(30);
      expect(result.medianDissolvedOxygen).toBe(8);
      expect(result.medianFlowRate).toBe(3);
      expect(result.medianNitrogen).toBe(2);
      expect(result.medianPhosphorus).toBe(0.3);
      expect(result.medianTemperature).toBe(17);
      expect(result.oracleCount).toBe(5);
    });

    it('aggregates verified sensor readings directly, not oracle submission snapshots', async () => {
      readingQb.getRawOne.mockResolvedValue({
        ...zeroAggregationRow(),
        medianPh: '7.2',
        oracleCount: '1',
        startTime: new Date('2026-01-01T00:00:00Z'),
        endTime: new Date('2026-01-01T00:00:00Z'),
      });

      await service.aggregateReadings('proj-1');

      expect(readingRepo.createQueryBuilder).toHaveBeenCalledWith('reading');
      expect(submissionRepo.find).not.toHaveBeenCalled();
    });

    it('computes medians with percentile_cont(0.5) for all 7 sensor parameters and counts readings', async () => {
      readingQb.getRawOne.mockResolvedValue({
        ...zeroAggregationRow(),
        oracleCount: '3',
        startTime: new Date('2026-01-01T00:00:00Z'),
        endTime: new Date('2026-01-03T00:00:00Z'),
      });

      await service.aggregateReadings('proj-1');

      const selectCalls = [...readingQb.select.mock.calls, ...readingQb.addSelect.mock.calls];
      const medianSelects = selectCalls.filter(([sql]) =>
        String(sql).includes('percentile_cont(0.5)'),
      );

      expect(medianSelects).toHaveLength(7);
      for (const column of [
        'reading.ph',
        'reading.turbidity',
        'reading.dissolved_oxygen',
        'reading.flow_rate',
        'reading.nitrogen',
        'reading.phosphorus',
        'reading.temperature',
      ]) {
        expect(medianSelects.some(([sql]) => String(sql).includes(column))).toBe(true);
      }
      expect(readingQb.addSelect).toHaveBeenCalledWith('COUNT(*)', 'oracleCount');
    });

    it('filters by project_id, is_verified = true, and the requested time range', async () => {
      const startTime = new Date('2026-01-01T00:00:00Z');
      const endTime = new Date('2026-01-31T23:59:59Z');
      readingQb.getRawOne.mockResolvedValue({
        ...zeroAggregationRow(),
        medianPh: '7.2',
        oracleCount: '3',
        startTime,
        endTime,
      });

      const result = await service.aggregateReadings('proj-1', startTime, endTime);

      expect(result.oracleCount).toBe(3);
      expect(readingQb.where).toHaveBeenCalledWith('reading.project_id = :projectId', {
        projectId: 'proj-1',
      });
      expect(readingQb.andWhere).toHaveBeenCalledWith('reading.is_verified = true');
      expect(readingQb.andWhere).toHaveBeenCalledWith(
        'reading.timestamp BETWEEN :startTime AND :endTime',
        { startTime, endTime },
      );
    });

    it('skips the time-range filter when startTime or endTime is omitted', async () => {
      readingQb.getRawOne.mockResolvedValue({
        ...zeroAggregationRow(),
        medianPh: '7.2',
        oracleCount: '2',
        startTime: new Date('2026-01-01T00:00:00Z'),
        endTime: new Date('2026-01-02T00:00:00Z'),
      });

      await service.aggregateReadings('proj-1', new Date('2026-01-01T00:00:00Z'));

      expect(readingQb.andWhere).toHaveBeenCalledWith('reading.is_verified = true');
      expect(readingQb.andWhere).not.toHaveBeenCalledWith(
        expect.stringContaining('timestamp BETWEEN'),
        expect.anything(),
      );
    });

    it('throws NotFoundException when no verified readings match the project and time range', async () => {
      readingQb.getRawOne.mockResolvedValue(zeroAggregationRow());

      await expect(service.aggregateReadings('proj-empty')).rejects.toThrow(NotFoundException);
    });

    it('maps NULL medians (readings without a value for a parameter) to null', async () => {
      readingQb.getRawOne.mockResolvedValue({
        ...zeroAggregationRow(),
        medianPh: null,
        medianTurbidity: '11',
        medianDissolvedOxygen: null,
        medianFlowRate: null,
        medianNitrogen: null,
        medianPhosphorus: null,
        medianTemperature: null,
        oracleCount: '3',
        startTime: new Date('2026-01-01T00:00:00Z'),
        endTime: new Date('2026-01-03T00:00:00Z'),
      });

      const result = await service.aggregateReadings('proj-1');

      expect(result.medianPh).toBeNull();
      expect(result.medianTurbidity).toBe(11);
      expect(result.medianDissolvedOxygen).toBeNull();
      expect(result.medianFlowRate).toBeNull();
      expect(result.medianNitrogen).toBeNull();
      expect(result.medianPhosphorus).toBeNull();
      expect(result.medianTemperature).toBeNull();
    });

    it('maps decimal medians returned by PostgreSQL (numeric strings) to numbers', async () => {
      readingQb.getRawOne.mockResolvedValue({
        ...zeroAggregationRow(),
        medianPh: '7.5',
        medianPhosphorus: '0.125',
        oracleCount: '4',
        startTime: new Date('2026-01-01T00:00:00Z'),
        endTime: new Date('2026-01-04T00:00:00Z'),
      });

      const result = await service.aggregateReadings('proj-1');

      expect(result.medianPh).toBe(7.5);
      expect(result.medianPhosphorus).toBe(0.125);
    });

    it('sets startTime and endTime from the earliest and latest verified reading timestamps', async () => {
      const t1 = new Date('2026-01-01T00:00:00Z');
      const t2 = new Date('2026-01-05T00:00:00Z');
      readingQb.getRawOne.mockResolvedValue({
        ...zeroAggregationRow(),
        medianPh: '7.2',
        oracleCount: '2',
        startTime: t1,
        endTime: t2,
      });

      const result = await service.aggregateReadings('proj-1');

      expect(result.startTime).toEqual(t1);
      expect(result.endTime).toEqual(t2);
    });
  });

  // ── Nonce-gap detection ─────────────────────────────────────────────────

  describe('detectNonceDrift', () => {
    it('logs no warning when local and on-chain nonces match', async () => {
      submissionRepo.findOne.mockResolvedValue(makeSubmission({ nonce: 5 }) as never);
      stellarService.getOracleNonce.mockResolvedValue(5);

      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});

      await service.detectNonceDrift('contract-id', 'GABC');
      expect(warnSpy).not.toHaveBeenCalled();

      warnSpy.mockRestore();
    });

    it('logs a warning when local and on-chain nonces diverge by more than 1', async () => {
      submissionRepo.findOne.mockResolvedValue(makeSubmission({ nonce: 3 }) as never);
      stellarService.getOracleNonce.mockResolvedValue(10);

      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});

      await service.detectNonceDrift('contract-id', 'GABC');
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Nonce drift detected'));

      warnSpy.mockRestore();
    });

    it('logs a warning and returns early when stellar call fails', async () => {
      submissionRepo.findOne.mockResolvedValue(makeSubmission({ nonce: 3 }) as never);
      stellarService.getOracleNonce.mockRejectedValue(new Error('network error'));

      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});

      await service.detectNonceDrift('contract-id', 'GABC');
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('could not read on-chain nonce'),
      );

      warnSpy.mockRestore();
    });
  });

  // ── findStaleSubmissions ─────────────────────────────────────────────────

  describe('findStaleSubmissions', () => {
    it('returns submissions beyond on-chain nonce', async () => {
      stellarService.getOracleNonce.mockResolvedValue(5);
      submissionRepo.find.mockResolvedValue([
        makeSubmission({ nonce: 7 }),
        makeSubmission({ nonce: 6 }),
      ] as never);

      const result = await service.findStaleSubmissions('contract-id', 'GABC');
      expect(result).toHaveLength(2);
    });

    it('returns empty array when stellar call fails', async () => {
      stellarService.getOracleNonce.mockRejectedValue(new Error('network error'));

      const result = await service.findStaleSubmissions('contract-id', 'GABC');
      expect(result).toEqual([]);
    });
  });

  // getUniqueOracleAddresses
  describe('getUniqueOracleAddresses', () => {
    it('returns unique oracle addresses from submissions', async () => {
      const distinctMock = {
        select: jest.fn().mockReturnThis(),
        getRawMany: jest
          .fn()
          .mockResolvedValue([{ oracleAddress: 'GABC' }, { oracleAddress: 'GXYZ' }]),
      };
      submissionRepo.createQueryBuilder.mockReturnValue(distinctMock as any);

      const result = await service.getUniqueOracleAddresses();
      expect(result).toEqual(['GABC', 'GXYZ']);
    });
  });

  // reconcile
  describe('reconcile', () => {
    it('heals stale submissions by re-sequencing and re-queueing them', async () => {
      stellarService.getOracleNonce.mockResolvedValue(5);

      const staleSubmissions = [
        makeSubmission({ id: 'sub-stale-1', nonce: 7, projectId: 'proj-1', oracleAddress: 'GABC' }),
        makeSubmission({ id: 'sub-stale-2', nonce: 8, projectId: 'proj-1', oracleAddress: 'GABC' }),
      ];

      submissionRepo.find
        .mockResolvedValueOnce(staleSubmissions as never)
        .mockResolvedValueOnce([] as never);

      await service.reconcile('contract-id', 'GABC');

      expect(staleSubmissions[0].nonce).toBe(6);
      expect(staleSubmissions[0].status).toBe(SubmissionStatus.PENDING);
      expect(staleSubmissions[1].nonce).toBe(7);
      expect(staleSubmissions[1].status).toBe(SubmissionStatus.PENDING);

      expect(oracleQueue.add).toHaveBeenCalledTimes(2);
      expect(oracleQueue.add).toHaveBeenNthCalledWith(
        1,
        'oracle-submit-job',
        expect.objectContaining({ submissionId: 'sub-stale-1', nonce: 6 }),
        expect.objectContaining({ delay: 0 }),
      );
      expect(oracleQueue.add).toHaveBeenNthCalledWith(
        2,
        'oracle-submit-job',
        expect.objectContaining({ submissionId: 'sub-stale-2', nonce: 7 }),
        expect.objectContaining({ delay: 5000 }),
      );
    });

    it('heals gap submissions by marking them CONFIRMED and calculating credits', async () => {
      stellarService.getOracleNonce.mockResolvedValue(5);

      const gapSub = makeSubmission({
        id: 'sub-gap',
        nonce: 4,
        projectId: 'proj-1',
        oracleAddress: 'GABC',
      });

      submissionRepo.find
        .mockResolvedValueOnce([] as never)
        .mockResolvedValueOnce([gapSub] as never);

      const mockProject = { id: 'proj-1', areaHectares: 10 };
      const mockConfig = { id: 1 };
      const mockBatch = { id: 'batch-1', status: 'PENDING' };

      const projectRepo = service['projectRepo'];
      const configRepo = service['governanceConfigRepo'];
      const batchRepo = service['batchRepo'];
      const creditScoringService = service['creditScoringService'];

      jest.spyOn(projectRepo, 'findOne').mockResolvedValue(mockProject as any);
      jest.spyOn(configRepo, 'findOne').mockResolvedValue(mockConfig as any);
      jest.spyOn(batchRepo, 'findOne').mockResolvedValue(mockBatch as any);
      jest.spyOn(creditScoringService, 'calculate').mockReturnValue({ toNumber: () => 150 } as any);

      await service.reconcile('contract-id', 'GABC');

      expect(gapSub.status).toBe(SubmissionStatus.CONFIRMED);
      expect(gapSub.txHash).toBe('reconciled-on-chain');
      expect(gapSub.result).toMatchObject({ reconciled: true });

      expect(batchRepo.findOne).toHaveBeenCalled();
      expect(batchRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'batch-1',
          status: 'confirmed',
          creditsGenerated: 150,
        }),
      );
    });
  });
});
