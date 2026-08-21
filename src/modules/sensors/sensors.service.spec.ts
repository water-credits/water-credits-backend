import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';
import { getQueueToken } from '@nestjs/bull';
import { DataSource } from 'typeorm';
import { Keypair } from '@stellar/stellar-sdk';
import { SensorsService } from './sensors.service';
import { SensorDevice } from './entities/sensor-device.entity';
import { SensorReading } from './entities/sensor-reading.entity';
import { ReadingBatch, BatchStatus } from './entities/reading-batch.entity';
import { CreateReadingDto } from './dto/create-reading.dto';
import { SensorProjectAccessService } from './sensor-project-access.service';
import { UserRole } from '../users/entities/user.entity';

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a valid base64-encoded Ed25519 signature for the given payload using
 * the provided Stellar Keypair.  This exercises the real @stellar/stellar-sdk
 * crypto path — no mocks involved.
 */
function signPayload(keypair: Keypair, payload: string): string {
  const sig = keypair.sign(Buffer.from(payload, 'utf-8'));
  return Buffer.from(sig).toString('base64');
}

/**
 * Reconstruct the pipe-delimited payload string that SensorsService builds
 * internally so tests can sign the correct bytes.
 */
function buildPayload(
  deviceId: string,
  timestamp: string,
  params: Record<string, number | null | undefined>,
): string {
  const parts = [deviceId, timestamp];
  for (const key of [
    'ph',
    'turbidity',
    'dissolvedOxygen',
    'flowRate',
    'nitrogen',
    'phosphorus',
    'temperature',
  ]) {
    const val = params[key];
    parts.push(val?.toString() ?? '');
  }
  return parts.join('|');
}

// ── Typed mock factories ──────────────────────────────────────────────────────

type MockRepo = {
  findOne: jest.Mock;
  find: jest.Mock;
  create: jest.Mock;
  save: jest.Mock;
  update: jest.Mock;
  increment: jest.Mock;
  createQueryBuilder: jest.Mock;
};

function makeMockRepo(): MockRepo {
  return {
    findOne: jest.fn(),
    find: jest.fn(),
    create: jest.fn(),
    save: jest.fn(),
    update: jest.fn(),
    increment: jest.fn(),
    createQueryBuilder: jest.fn(),
  };
}

type MockDataSource = {
  query: jest.Mock;
  transaction: jest.Mock;
};

function makeMockDataSource(): MockDataSource {
  return {
    query: jest.fn(),
    transaction: jest.fn((callback) =>
      Promise.resolve(callback({ save: jest.fn(), increment: jest.fn() })),
    ),
  };
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('SensorsService', () => {
  let service: SensorsService;
  let deviceRepo: MockRepo;
  let readingRepo: MockRepo;
  let batchRepo: MockRepo;
  let dataSource: MockDataSource;
  let sensorQueue: { add: jest.Mock };

  // A real Stellar keypair used for signature tests — generated once per suite.
  let testKeypair: Keypair;

  beforeAll(() => {
    testKeypair = Keypair.random();
  });

  beforeEach(async () => {
    deviceRepo = makeMockRepo();
    readingRepo = makeMockRepo();
    batchRepo = makeMockRepo();
    dataSource = makeMockDataSource();
    sensorQueue = { add: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SensorsService,
        { provide: getRepositoryToken(SensorDevice), useValue: deviceRepo },
        { provide: getRepositoryToken(SensorReading), useValue: readingRepo },
        { provide: getRepositoryToken(ReadingBatch), useValue: batchRepo },
        { provide: getQueueToken('sensor-ingestion'), useValue: sensorQueue },
        { provide: DataSource, useValue: dataSource },
        {
          provide: SensorProjectAccessService,
          useValue: { assertProjectAccess: jest.fn(), requirePrivilegedRole: jest.fn() },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              const config: Record<string, number> = {
                'sensor.maxAgeSeconds': 86400,
                'sensor.futureOffsetSeconds': 300,
              };
              return config[key] || null;
            }),
          },
        },
      ],
    }).compile();

    service = module.get<SensorsService>(SensorsService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  // ── verifySignature (via ingestReading) ──────────────────────────────────

  describe('ingestReading — signature verification', () => {
    const TIMESTAMP = new Date().toISOString();
    const PARAMS = {
      ph: 7.0,
      turbidity: null,
      dissolvedOxygen: null,
      flowRate: null,
      nitrogen: null,
      phosphorus: null,
      temperature: 20,
    };

    let fakeDevice: SensorDevice;

    beforeEach(() => {
      fakeDevice = {
        id: 'device-uuid-1',
        deviceId: 'dev-001',
        projectId: 'proj-1',
        publicKey: testKeypair.publicKey(),
        manufacturer: 'YSI',
        model: 'ProDSS',
        parameters: null,
        apiKeyHash: null,
        isActive: true,
        lastReadingAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as SensorDevice;

      deviceRepo.findOne.mockResolvedValue(fakeDevice);
      readingRepo.create.mockImplementation((data) => data as SensorReading);
      readingRepo.save.mockImplementation((r) =>
        Promise.resolve({ ...r, id: 'reading-uuid-1' } as SensorReading),
      );
      deviceRepo.update.mockResolvedValue(undefined);
      batchRepo.increment.mockResolvedValue(undefined);

      // Mock dataSource.transaction to use the real save and increment mocks
      dataSource.transaction.mockImplementation(
        (callback) =>
          callback({
            save: readingRepo.save,
            increment: jest.fn((entity, where, column, value) =>
              batchRepo.increment(where, column, value),
            ),
          }),
      );

      // Wire the three raw queries that resolveBatch() issues:
      //   query[0] — UPDATE stale batches (returns void)
      //   query[1] — INSERT … ON CONFLICT DO NOTHING (returns void)
      //   query[2] — SELECT the current PENDING batch row
      const fakeBatchRow = {
        id: 'batch-1',
        project_id: 'proj-1',
        status: BatchStatus.PENDING,
        reading_count: 0,
        created_at: new Date(),
        updated_at: new Date(),
      };
      dataSource.query
        .mockResolvedValueOnce(undefined) // UPDATE stale
        .mockResolvedValueOnce(undefined) // INSERT ON CONFLICT
        .mockResolvedValueOnce([fakeBatchRow]); // SELECT PENDING
      batchRepo.create.mockImplementation((d) => d as ReadingBatch);
    });

    it('accepts a valid ECDSA signature (real keypair, no mock)', async () => {
      const payload = buildPayload('dev-001', TIMESTAMP, PARAMS);
      const signature = signPayload(testKeypair, payload);

      const dto: CreateReadingDto = {
        deviceId: 'dev-001',
        timestamp: TIMESTAMP,
        ph: PARAMS.ph,
        temperature: PARAMS.temperature,
        signature,
      };

      const result = await service.ingestReading(dto);
      expect(result).toBeDefined();
      expect(readingRepo.save).toHaveBeenCalled();
    });

    it('enqueues a sensor-ingestion job after saving the reading', async () => {
      const payload = buildPayload('dev-001', TIMESTAMP, PARAMS);
      const signature = signPayload(testKeypair, payload);

      const dto: CreateReadingDto = {
        deviceId: 'dev-001',
        timestamp: TIMESTAMP,
        ph: PARAMS.ph,
        temperature: PARAMS.temperature,
        signature,
      };

      const result = await service.ingestReading(dto);

      expect(sensorQueue.add).toHaveBeenCalledTimes(1);
      expect(sensorQueue.add).toHaveBeenCalledWith({
        readingId: result.id,
        deviceId: fakeDevice.id,
        projectId: fakeDevice.projectId,
      });
    });

    it('rejects a signature signed by a different keypair', async () => {
      const otherKeypair = Keypair.random();
      const payload = buildPayload('dev-001', TIMESTAMP, PARAMS);
      const wrongSignature = signPayload(otherKeypair, payload); // signed with wrong key

      const dto: CreateReadingDto = {
        deviceId: 'dev-001',
        timestamp: TIMESTAMP,
        ph: PARAMS.ph,
        temperature: PARAMS.temperature,
        signature: wrongSignature,
      };

      await expect(service.ingestReading(dto)).rejects.toThrow(BadRequestException);
      await expect(service.ingestReading(dto)).rejects.toThrow('Invalid reading signature');
    });

    it('rejects a malformed public key stored on the device', async () => {
      fakeDevice.publicKey = 'not-a-valid-stellar-key';
      deviceRepo.findOne.mockResolvedValue(fakeDevice);

      const dto: CreateReadingDto = {
        deviceId: 'dev-001',
        timestamp: TIMESTAMP,
        ph: 7.0,
        signature: 'aGVsbG8=', // arbitrary base64
      };

      // A malformed public key causes Keypair.fromPublicKey to throw internally;
      // verifySignature catches it and returns false → BadRequestException.
      await expect(service.ingestReading(dto)).rejects.toThrow(BadRequestException);
    });

    it('rejects when device is not found', async () => {
      deviceRepo.findOne.mockResolvedValue(null);

      const dto: CreateReadingDto = {
        deviceId: 'unknown-device',
        timestamp: TIMESTAMP,
        signature: 'aGVsbG8=',
      };

      await expect(service.ingestReading(dto)).rejects.toThrow(NotFoundException);
    });
  });

  // ── validateParameters (via ingestReading) ───────────────────────────────

  describe('ingestReading — parameter range validation', () => {
    let fakeDevice: SensorDevice;

    beforeEach(() => {
      fakeDevice = {
        id: 'device-uuid-1',
        deviceId: 'dev-001',
        projectId: 'proj-1',
        publicKey: testKeypair.publicKey(),
        manufacturer: 'YSI',
        model: 'ProDSS',
        parameters: null,
        apiKeyHash: null,
        isActive: true,
        lastReadingAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as SensorDevice;

      deviceRepo.findOne.mockResolvedValue(fakeDevice);
    });

    it('throws BadRequestException when ph exceeds 14', async () => {
      // Validation fires before signature check, so signature value does not matter here.
      const dto: CreateReadingDto = {
        deviceId: 'dev-001',
        timestamp: new Date().toISOString(),
        ph: 15, // out of range
        signature: 'aGVsbG8=',
      };

      await expect(service.ingestReading(dto)).rejects.toThrow(BadRequestException);
      await expect(service.ingestReading(dto)).rejects.toThrow("'ph'");
    });

    it('throws BadRequestException when ph is below 0', async () => {
      const dto: CreateReadingDto = {
        deviceId: 'dev-001',
        timestamp: new Date().toISOString(),
        ph: -1,
        signature: 'aGVsbG8=',
      };

      await expect(service.ingestReading(dto)).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException when temperature exceeds 100', async () => {
      const dto: CreateReadingDto = {
        deviceId: 'dev-001',
        timestamp: new Date().toISOString(),
        temperature: 101,
        signature: 'aGVsbG8=',
      };

      await expect(service.ingestReading(dto)).rejects.toThrow(BadRequestException);
      await expect(service.ingestReading(dto)).rejects.toThrow("'temperature'");
    });

    it('throws BadRequestException when temperature is below -50', async () => {
      const dto: CreateReadingDto = {
        deviceId: 'dev-001',
        timestamp: new Date().toISOString(),
        temperature: -51,
        signature: 'aGVsbG8=',
      };

      await expect(service.ingestReading(dto)).rejects.toThrow(BadRequestException);
    });

    it('accepts boundary values ph=0 and ph=14 without throwing', async () => {
      // We only need to confirm validation passes; the subsequent signature
      // check will throw BadRequestException which is fine for this test.
      const dtoMin: CreateReadingDto = {
        deviceId: 'dev-001',
        timestamp: new Date().toISOString(),
        ph: 0,
        signature: 'aGVsbG8=',
      };
      // Expect BadRequestException from signature (not from validation)
      await expect(service.ingestReading(dtoMin)).rejects.toThrow('Invalid reading signature');

      const dtoMax: CreateReadingDto = {
        deviceId: 'dev-001',
        timestamp: new Date().toISOString(),
        ph: 14,
        signature: 'aGVsbG8=',
      };
      await expect(service.ingestReading(dtoMax)).rejects.toThrow('Invalid reading signature');
    });

    it('skips validation for null/undefined optional parameters', async () => {
      const dto: CreateReadingDto = {
        deviceId: 'dev-001',
        timestamp: new Date().toISOString(),
        // all optional params omitted → all null
        signature: 'aGVsbG8=',
      };
      // Validation passes; only the signature is rejected.
      await expect(service.ingestReading(dto)).rejects.toThrow('Invalid reading signature');
    });
  });

  // ── resolveBatch — 15-minute window boundary ─────────────────────────────

  describe('ingestReading — batch window boundary (resolveBatch)', () => {
    const TIMESTAMP = new Date().toISOString();

    let fakeDevice: SensorDevice;
    let validSignature: string;

    /**
     * Helper: set up the three dataSource.query calls that resolveBatch() issues.
     *
     *   call 0 — UPDATE stale batches (void)
     *   call 1 — INSERT … ON CONFLICT DO NOTHING (void)
     *   call 2 — SELECT PENDING batch → returns batchRow
     */
    function wireResolveBatch(batchRow: {
      id: string;
      project_id: string;
      status: BatchStatus;
      reading_count: number;
      created_at: Date;
      updated_at: Date;
    }) {
      dataSource.query
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce([batchRow]);
      batchRepo.create.mockImplementation((d) => d as ReadingBatch);
    }

    beforeEach(() => {
      fakeDevice = {
        id: 'device-uuid-1',
        deviceId: 'dev-001',
        projectId: 'proj-1',
        publicKey: testKeypair.publicKey(),
        manufacturer: 'YSI',
        model: 'ProDSS',
        parameters: null,
        apiKeyHash: null,
        isActive: true,
        lastReadingAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as SensorDevice;

      deviceRepo.findOne.mockResolvedValue(fakeDevice);
      readingRepo.create.mockImplementation((data) => data as SensorReading);
      readingRepo.save.mockImplementation((r) =>
        Promise.resolve({ ...r, id: 'reading-uuid-1' } as SensorReading),
      );
      deviceRepo.update.mockResolvedValue(undefined);
      batchRepo.increment.mockResolvedValue(undefined);

      // Mock dataSource.transaction to use the real save and increment mocks
      dataSource.transaction.mockImplementation(
        (callback) =>
          callback({
            save: readingRepo.save,
            increment: jest.fn((entity, where, column, value) =>
              batchRepo.increment(where, column, value),
            ),
          }),
      );

      // Build a valid signature for an all-null param set
      const payload = buildPayload('dev-001', TIMESTAMP, {
        ph: null,
        turbidity: null,
        dissolvedOxygen: null,
        flowRate: null,
        nitrogen: null,
        phosphorus: null,
        temperature: null,
      });
      validSignature = signPayload(testKeypair, payload);
    });

    it('resolves the batch and increments readingCount via the race-safe raw query path', async () => {
      const batchRow = {
        id: 'batch-1',
        project_id: 'proj-1',
        status: BatchStatus.PENDING,
        reading_count: 0,
        created_at: new Date(),
        updated_at: new Date(),
      };
      wireResolveBatch(batchRow);

      await service.ingestReading({
        deviceId: 'dev-001',
        timestamp: TIMESTAMP,
        signature: validSignature,
      });

      // Three raw queries issued: UPDATE stale, INSERT ON CONFLICT, SELECT.
      expect(dataSource.query).toHaveBeenCalledTimes(3);
      // The UPDATE (first call) should filter by PENDING status and the cutoff.
      expect(dataSource.query).toHaveBeenNthCalledWith(
        1,
        expect.stringContaining('UPDATE reading_batches'),
        expect.arrayContaining([BatchStatus.SUBMITTED, 'proj-1', BatchStatus.PENDING]),
      );
      // The INSERT (second call) should use ON CONFLICT DO NOTHING.
      expect(dataSource.query).toHaveBeenNthCalledWith(
        2,
        expect.stringContaining('ON CONFLICT'),
        expect.arrayContaining(['proj-1', BatchStatus.PENDING]),
      );
      // readingCount incremented on the resolved batch.
      expect(batchRepo.increment).toHaveBeenCalledWith({ id: 'batch-1' }, 'readingCount', 1);
    });

    it('resolveBatch issues exactly 3 raw queries regardless of whether an existing batch was found', async () => {
      const batchRow = {
        id: 'batch-fresh',
        project_id: 'proj-1',
        status: BatchStatus.PENDING,
        reading_count: 0,
        created_at: new Date(),
        updated_at: new Date(),
      };
      wireResolveBatch(batchRow);

      await service.ingestReading({
        deviceId: 'dev-001',
        timestamp: TIMESTAMP,
        signature: validSignature,
      });

      // Always: UPDATE stale, INSERT ON CONFLICT, SELECT — 3 queries, no more.
      expect(dataSource.query).toHaveBeenCalledTimes(3);
    });

    it('uses exactly the 15-minute boundary: the UPDATE uses cutoff = NOW() - BATCH_WINDOW_MS', async () => {
      jest.useFakeTimers();
      const FROZEN_NOW = 1_700_000_000_000;
      jest.setSystemTime(FROZEN_NOW);
      // Generate timestamp using frozen time so it's valid
      const frozenTimestamp = new Date(FROZEN_NOW).toISOString();

      const batchRow = {
        id: 'batch-cutoff',
        project_id: 'proj-1',
        status: BatchStatus.PENDING,
        reading_count: 0,
        created_at: new Date(FROZEN_NOW),
        updated_at: new Date(FROZEN_NOW),
      };
      wireResolveBatch(batchRow);

      // Regenerate signature with the frozen timestamp using null params
      const frozenPayload = buildPayload('dev-001', frozenTimestamp, {
        ph: null,
        turbidity: null,
        dissolvedOxygen: null,
        flowRate: null,
        nitrogen: null,
        phosphorus: null,
        temperature: null,
      });
      const frozenSignature = signPayload(testKeypair, frozenPayload);

      await service.ingestReading({
        deviceId: 'dev-001',
        timestamp: frozenTimestamp,
        signature: frozenSignature,
      });

      jest.useRealTimers();

      // The fourth argument to the UPDATE query must be the cutoff Date.
      const updateArgs = dataSource.query.mock.calls[0][1] as unknown[];
      const cutoffArg = updateArgs[3] as Date;
      expect(cutoffArg).toBeInstanceOf(Date);
      expect(cutoffArg.getTime()).toBe(FROZEN_NOW - 15 * 60 * 1000);
    });
  });

  // ── getLatestReading — N+1 fix ───────────────────────────────────────────

  describe('getLatestReading', () => {
    it('returns the latest reading for a specific deviceId', async () => {
      const fakeDevice: Partial<SensorDevice> = {
        id: 'device-uuid-1',
        deviceId: 'dev-001',
        projectId: 'proj-1',
        publicKey: testKeypair.publicKey(),
      };

      const fakeReading: Partial<SensorReading> = {
        id: 'reading-uuid-1',
        deviceId: 'device-uuid-1',
        ph: 7.1,
        timestamp: new Date(),
      };

      deviceRepo.findOne.mockResolvedValue(fakeDevice as SensorDevice);
      readingRepo.findOne.mockResolvedValue(fakeReading as SensorReading);

      const result = await service.getLatestReading('user-1', 'farmer', 'dev-001');

      expect(result).toEqual(fakeReading);
      expect(readingRepo.findOne).toHaveBeenCalledTimes(1);
    });

    it('throws NotFoundException when no readings exist for the given deviceId', async () => {
      const fakeDevice: Partial<SensorDevice> = {
        id: 'device-uuid-1',
        deviceId: 'dev-001',
        projectId: 'proj-1',
        publicKey: testKeypair.publicKey(),
      };

      deviceRepo.findOne.mockResolvedValue(fakeDevice as SensorDevice);
      readingRepo.findOne.mockResolvedValue(null);

      await expect(service.getLatestReading('user-1', 'farmer', 'dev-001')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('getLatestReading() without deviceId should fetch all latest readings in a single query instead of one findOne per device', async () => {
      // The fix replaces the per-device findOne loop with a single
      // DISTINCT ON (device_id) raw query.  We verify:
      //   1. dataSource.query is called exactly once (single round-trip).
      //   2. readingRepo.findOne is never called (N+1 path is gone).
      //   3. The returned array contains one typed SensorReading per row.

      const rawRows = [
        {
          id: 'r-1',
          device_id: 'dev-uuid-1',
          project_id: 'proj-1',
          timestamp: new Date(),
          ph: '7.0',
          turbidity: null,
          dissolved_oxygen: null,
          flow_rate: null,
          nitrogen: null,
          phosphorus: null,
          temperature: '18.5',
          signature: 'sig1',
          is_verified: true,
          batch_id: 'batch-1',
          created_at: new Date(),
        },
        {
          id: 'r-2',
          device_id: 'dev-uuid-2',
          project_id: 'proj-1',
          timestamp: new Date(),
          ph: '6.8',
          turbidity: '11.0',
          dissolved_oxygen: null,
          flow_rate: null,
          nitrogen: null,
          phosphorus: null,
          temperature: null,
          signature: 'sig2',
          is_verified: false,
          batch_id: null,
          created_at: new Date(),
        },
      ];

      // dataSource.query returns the raw rows for the DISTINCT ON query.
      dataSource.query.mockResolvedValueOnce(rawRows);
      // readingRepo.create maps each row to a typed entity.
      readingRepo.create.mockImplementation((d) => d as SensorReading);

      const result = (await service.getLatestReading('admin-1', 'admin')) as SensorReading[];

      // ── Assertion 1: single DB round-trip ──
      expect(dataSource.query).toHaveBeenCalledTimes(1);
      const [sql] = dataSource.query.mock.calls[0] as [string];
      expect(sql).toMatch(/DISTINCT ON\s*\(\s*device_id\s*\)/i);

      // ── Assertion 2: N+1 path is gone ──
      expect(readingRepo.findOne).not.toHaveBeenCalled();
      expect(deviceRepo.find).not.toHaveBeenCalled();

      // ── Assertion 3: result shape ──
      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({ id: 'r-1', ph: 7.0, temperature: 18.5 });
      expect(result[1]).toMatchObject({ id: 'r-2', ph: 6.8, turbidity: 11.0 });
    });

    it('returns an empty array when no readings exist (no-deviceId path)', async () => {
      dataSource.query.mockResolvedValueOnce([]);
      readingRepo.create.mockImplementation((d) => d as SensorReading);

      const result = (await service.getLatestReading('admin-1', 'admin')) as SensorReading[];

      expect(dataSource.query).toHaveBeenCalledTimes(1);
      expect(result).toHaveLength(0);
    });
  });
});

// NOTE: The closing `});` above is the end of the main describe block.
// The following describe blocks are intentionally OUTSIDE the main describe
// to keep the mock setup clean — they create their own module in beforeEach.

describe('SensorsService — registerDevice', () => {
  let service: SensorsService;
  let deviceRepo: {
    findOne: jest.Mock;
    find: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    update: jest.Mock;
    increment: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let readingRepo: {
    findOne: jest.Mock;
    find: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    update: jest.Mock;
    increment: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let batchRepo: {
    findOne: jest.Mock;
    find: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    update: jest.Mock;
    increment: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let projectAccessService: SensorProjectAccessService;

  let testKeypair: Keypair;

  beforeAll(() => {
    testKeypair = Keypair.random();
  });

  beforeEach(async () => {
    deviceRepo = {
      findOne: jest.fn(),
      find: jest.fn(),
      create: jest.fn(),
      save: jest.fn(),
      update: jest.fn(),
      increment: jest.fn(),
      createQueryBuilder: jest.fn(),
    };
    readingRepo = {
      findOne: jest.fn(),
      find: jest.fn(),
      create: jest.fn(),
      save: jest.fn(),
      update: jest.fn(),
      increment: jest.fn(),
      createQueryBuilder: jest.fn(),
    };
    batchRepo = {
      findOne: jest.fn(),
      find: jest.fn(),
      create: jest.fn(),
      save: jest.fn(),
      update: jest.fn(),
      increment: jest.fn(),
      createQueryBuilder: jest.fn(),
    };

    // Use a real SensorProjectAccessService backed by a mock ProjectsService
    // so that the ownership check is exercised in registerDevice tests.
    const mockProjectsService = {
      findById: jest.fn().mockResolvedValue({ id: 'proj-1', ownerId: 'owner-1' }),
    };
    projectAccessService = new SensorProjectAccessService(
      mockProjectsService as unknown as import('../projects/projects.service').ProjectsService,
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SensorsService,
        { provide: getRepositoryToken(SensorDevice), useValue: deviceRepo },
        { provide: getRepositoryToken(SensorReading), useValue: readingRepo },
        { provide: getRepositoryToken(ReadingBatch), useValue: batchRepo },
        { provide: getQueueToken('sensor-ingestion'), useValue: { add: jest.fn() } },
        { provide: DataSource, useValue: makeMockDataSource() },
        {
          provide: SensorProjectAccessService,
          useValue: projectAccessService,
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              const config: Record<string, number> = {
                'sensor.maxAgeSeconds': 86400,
                'sensor.futureOffsetSeconds': 300,
              };
              return config[key] || null;
            }),
          },
        },
      ],
    }).compile();

    service = module.get<SensorsService>(SensorsService);
  });

  const BASE_DTO = {
    projectId: 'proj-1',
    deviceId: 'dev-new-001',
    manufacturer: 'YSI',
    model: 'ProDSS',
    parameters: ['ph', 'temperature'],
  };

  it('creates and returns a device with an apiKeyPlaintext on first registration', async () => {
    deviceRepo.findOne.mockResolvedValue(null);
    const savedDevice: SensorDevice = {
      id: 'device-uuid-new',
      projectId: BASE_DTO.projectId,
      deviceId: BASE_DTO.deviceId,
      manufacturer: BASE_DTO.manufacturer,
      model: BASE_DTO.model,
      publicKey: testKeypair.publicKey(),
      parameters: null,
      apiKeyHash: 'hashed',
      isActive: true,
      lastReadingAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      project: null as never,
    };
    deviceRepo.create.mockReturnValue(savedDevice);
    deviceRepo.save.mockResolvedValue(savedDevice);

    // publicKey is set per test using real keypair
    const dto = { ...BASE_DTO, publicKey: testKeypair.publicKey() };
    const result = await service.registerDevice('proj-1', dto as never, 'owner-1', 'farmer');

    expect(deviceRepo.save).toHaveBeenCalled();
    expect(result.apiKeyPlaintext).toBeDefined();
    expect(result.apiKeyPlaintext).toMatch(/^wc_dev-new-001_/);
  });

  it('throws BadRequestException when deviceId is already registered', async () => {
    const existing = { id: 'device-uuid-existing', deviceId: BASE_DTO.deviceId } as SensorDevice;
    deviceRepo.findOne.mockResolvedValue(existing);

    const dto = { ...BASE_DTO, publicKey: testKeypair.publicKey() };
    await expect(
      service.registerDevice('proj-1', dto as never, 'owner-1', 'farmer'),
    ).rejects.toThrow(BadRequestException);
    await expect(
      service.registerDevice('proj-1', dto as never, 'owner-1', 'farmer'),
    ).rejects.toThrow('already registered');
  });

  it('filters devices by projectId', async () => {
    const devices = [{ id: 'dev-1', projectId: 'proj-1' }] as SensorDevice[];
    deviceRepo.find.mockResolvedValue(devices);

    const result = await service.getDevices('proj-1', 'owner-1', 'farmer');
    expect(result).toEqual(devices);
    expect(deviceRepo.find).toHaveBeenCalledWith({ where: { projectId: 'proj-1' } });
  });

  it('returns all devices when no projectId is given', async () => {
    const devices = [{ id: 'dev-1' }, { id: 'dev-2' }] as SensorDevice[];
    deviceRepo.find.mockResolvedValue(devices);

    const result = await service.getDevices(undefined, 'admin-1', 'admin');
    expect(result).toHaveLength(2);
    expect(deviceRepo.find).toHaveBeenCalledWith({ order: { createdAt: 'DESC' } });
  });

  it('getDeviceById returns device when found', async () => {
    const device = {
      id: 'device-uuid-1',
      deviceId: 'dev-001',
      projectId: 'proj-1',
    } as SensorDevice;
    deviceRepo.findOne.mockResolvedValue(device);

    const result = await service.getDeviceById('device-uuid-1', 'owner-1', 'farmer');
    expect(result).toEqual(device);
  });

  it('getDeviceById throws NotFoundException when device is not found', async () => {
    deviceRepo.findOne.mockResolvedValue(null);
    await expect(service.getDeviceById('nonexistent', 'user-1', 'farmer')).rejects.toThrow(
      NotFoundException,
    );
  });

  // ── Security: project ownership gate on registerDevice ──────────────────

  it('rejects registerDevice when caller does not own the project (User A vs User B)', async () => {
    // projectAccessService is backed by a mock ProjectsService that returns
    // { id: 'proj-1', ownerId: 'owner-1' }.  Calling as 'user-b' (farmer)
    // must throw ForbiddenException.
    const dto = { ...BASE_DTO, publicKey: testKeypair.publicKey() };
    await expect(
      service.registerDevice('proj-1', dto as never, 'user-b', UserRole.FARMER),
    ).rejects.toThrow(ForbiddenException);
  });

  it('allows registerDevice when caller is the project owner', async () => {
    // The mock ProjectsService returns ownerId: 'owner-1'.
    deviceRepo.findOne.mockResolvedValue(null);
    const savedDevice: SensorDevice = {
      id: 'device-uuid-new',
      projectId: 'proj-1',
      deviceId: 'dev-new-001',
      manufacturer: 'YSI',
      model: 'ProDSS',
      publicKey: testKeypair.publicKey(),
      parameters: null,
      apiKeyHash: 'hashed',
      isActive: true,
      lastReadingAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      project: null as never,
    };
    deviceRepo.create.mockReturnValue(savedDevice);
    deviceRepo.save.mockResolvedValue(savedDevice);

    const dto = { ...BASE_DTO, publicKey: testKeypair.publicKey() };
    const result = await service.registerDevice('proj-1', dto as never, 'owner-1', UserRole.FARMER);

    expect(result.apiKeyPlaintext).toBeDefined();
  });

  it('allows registerDevice when caller has a privileged role (admin)', async () => {
    deviceRepo.findOne.mockResolvedValue(null);
    const savedDevice: SensorDevice = {
      id: 'device-uuid-new',
      projectId: 'proj-1',
      deviceId: 'dev-new-001',
      manufacturer: 'YSI',
      model: 'ProDSS',
      publicKey: testKeypair.publicKey(),
      parameters: null,
      apiKeyHash: 'hashed',
      isActive: true,
      lastReadingAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      project: null as never,
    };
    deviceRepo.create.mockReturnValue(savedDevice);
    deviceRepo.save.mockResolvedValue(savedDevice);

    const dto = { ...BASE_DTO, publicKey: testKeypair.publicKey() };
    // 'other-user' is not the owner, but admin role is privileged → allowed
    const result = await service.registerDevice(
      'proj-1',
      dto as never,
      'other-user',
      UserRole.ADMIN,
    );

    expect(result.apiKeyPlaintext).toBeDefined();
  });
});

// ── Additional describe blocks ────────────────────────────────────────────

describe('SensorsService — getReadings', () => {
  let service: SensorsService;
  let readingRepo: MockRepo;
  let deviceRepo: MockRepo;
  let batchRepo: MockRepo;

  function makeQb() {
    return {
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
    };
  }

  beforeEach(async () => {
    deviceRepo = makeMockRepo();
    readingRepo = makeMockRepo();
    batchRepo = makeMockRepo();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SensorsService,
        { provide: getRepositoryToken(SensorDevice), useValue: deviceRepo },
        { provide: getRepositoryToken(SensorReading), useValue: readingRepo },
        { provide: getRepositoryToken(ReadingBatch), useValue: batchRepo },
        { provide: getQueueToken('sensor-ingestion'), useValue: { add: jest.fn() } },
        { provide: DataSource, useValue: makeMockDataSource() },
        {
          provide: SensorProjectAccessService,
          useValue: { assertProjectAccess: jest.fn(), requirePrivilegedRole: jest.fn() },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              const config: Record<string, number> = {
                'sensor.maxAgeSeconds': 86400,
                'sensor.futureOffsetSeconds': 300,
              };
              return config[key] || null;
            }),
          },
        },
      ],
    }).compile();

    service = module.get<SensorsService>(SensorsService);
  });

  it('returns paginated readings with no filters', async () => {
    const qb = makeQb();
    readingRepo.createQueryBuilder.mockReturnValue(qb);

    const result = await service.getReadings(
      { skip: 0, limit: 20, page: 1 } as never,
      'admin-1',
      'admin',
    );

    expect(qb.getManyAndCount).toHaveBeenCalled();
    expect(result.page).toBe(1);
    expect(result.limit).toBe(20);
  });

  it('filters by deviceId when provided', async () => {
    const qb = makeQb();
    readingRepo.createQueryBuilder.mockReturnValue(qb);
    deviceRepo.findOne.mockResolvedValue({
      id: 'device-1',
      deviceId: 'dev-001',
      projectId: 'proj-1',
    } as SensorDevice);

    await service.getReadings(
      { deviceId: 'dev-001', skip: 0, limit: 20, page: 1 } as never,
      'user-1',
      'farmer',
    );

    expect(qb.andWhere).toHaveBeenCalledWith(
      expect.stringContaining('device_id'),
      expect.any(Object),
    );
  });

  it('filters by projectId when provided', async () => {
    const qb = makeQb();
    readingRepo.createQueryBuilder.mockReturnValue(qb);

    await service.getReadings(
      { projectId: 'proj-1', skip: 0, limit: 20, page: 1 } as never,
      'user-1',
      'farmer',
    );

    expect(qb.andWhere).toHaveBeenCalledWith(
      expect.stringContaining('project_id'),
      expect.any(Object),
    );
  });

  it('filters by startDate and endDate when provided', async () => {
    const qb = makeQb();
    readingRepo.createQueryBuilder.mockReturnValue(qb);

    await service.getReadings(
      {
        startDate: '2026-01-01',
        endDate: '2026-12-31',
        skip: 0,
        limit: 20,
        page: 1,
      } as never,
      'admin-1',
      'admin',
    );

    expect(qb.andWhere).toHaveBeenCalledTimes(2);
  });
});

describe('SensorsService — getAggregatedSummary', () => {
  let service: SensorsService;
  let readingRepo: MockRepo;
  let deviceRepo: MockRepo;
  let batchRepo: MockRepo;

  beforeEach(async () => {
    deviceRepo = makeMockRepo();
    readingRepo = makeMockRepo();
    batchRepo = makeMockRepo();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SensorsService,
        { provide: getRepositoryToken(SensorDevice), useValue: deviceRepo },
        { provide: getRepositoryToken(SensorReading), useValue: readingRepo },
        { provide: getRepositoryToken(ReadingBatch), useValue: batchRepo },
        { provide: getQueueToken('sensor-ingestion'), useValue: { add: jest.fn() } },
        { provide: DataSource, useValue: makeMockDataSource() },
        {
          provide: SensorProjectAccessService,
          useValue: { assertProjectAccess: jest.fn(), requirePrivilegedRole: jest.fn() },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              const config: Record<string, number> = {
                'sensor.maxAgeSeconds': 86400,
                'sensor.futureOffsetSeconds': 300,
              };
              return config[key] || null;
            }),
          },
        },
      ],
    }).compile();

    service = module.get<SensorsService>(SensorsService);
  });

  it('returns aggregated values from query result', async () => {
    const qb = {
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getRawOne: jest.fn().mockResolvedValue({
        avgPh: '7.2',
        avgTurbidity: '11.5',
        avgDissolvedOxygen: '8.0',
        avgFlowRate: '1.5',
        avgNitrogen: '2.5',
        avgPhosphorus: '0.15',
        avgTemperature: '19.0',
        totalReadings: '42',
      }),
    };
    readingRepo.createQueryBuilder.mockReturnValue(qb);

    const result = await service.getAggregatedSummary('proj-1');

    expect(result.avgPh).toBeCloseTo(7.2);
    expect(result.totalReadings).toBe(42);
  });

  it('returns null for all averages when result is null', async () => {
    const qb = {
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getRawOne: jest.fn().mockResolvedValue(null),
    };
    readingRepo.createQueryBuilder.mockReturnValue(qb);

    const result = await service.getAggregatedSummary('proj-1');

    expect(result.avgPh).toBeNull();
    expect(result.totalReadings).toBe(0);
  });

  it('filters by startDate and endDate when provided', async () => {
    const qb = {
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getRawOne: jest.fn().mockResolvedValue(null),
    };
    readingRepo.createQueryBuilder.mockReturnValue(qb);

    await service.getAggregatedSummary('proj-1', '2026-01-01', '2026-12-31');

    expect(qb.andWhere).toHaveBeenCalledTimes(2);
  });
});

describe('SensorsService — validateParameters unknown key', () => {
  let service: SensorsService;
  let deviceRepo: MockRepo;
  let readingRepo: MockRepo;
  let batchRepo: MockRepo;
  let dataSource: MockDataSource;
  let testKeypair: Keypair;

  beforeAll(() => {
    testKeypair = Keypair.random();
  });

  beforeEach(async () => {
    deviceRepo = makeMockRepo();
    readingRepo = makeMockRepo();
    batchRepo = makeMockRepo();
    dataSource = makeMockDataSource();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SensorsService,
        { provide: getRepositoryToken(SensorDevice), useValue: deviceRepo },
        { provide: getRepositoryToken(SensorReading), useValue: readingRepo },
        { provide: getRepositoryToken(ReadingBatch), useValue: batchRepo },
        { provide: getQueueToken('sensor-ingestion'), useValue: { add: jest.fn() } },
        { provide: DataSource, useValue: dataSource },
        {
          provide: SensorProjectAccessService,
          useValue: { assertProjectAccess: jest.fn(), requirePrivilegedRole: jest.fn() },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              const config: Record<string, number> = {
                'sensor.maxAgeSeconds': 86400,
                'sensor.futureOffsetSeconds': 300,
              };
              return config[key] || null;
            }),
          },
        },
      ],
    }).compile();

    service = module.get<SensorsService>(SensorsService);

    // Setup mocks for ingestReading
    readingRepo.create.mockImplementation((data) => data as SensorReading);
    readingRepo.save.mockImplementation((r) =>
      Promise.resolve({ ...r, id: 'reading-uuid-1' } as SensorReading),
    );
    deviceRepo.update.mockResolvedValue(undefined);
    batchRepo.increment.mockResolvedValue(undefined);

    // Mock dataSource.transaction to use the real save and increment mocks
    dataSource.transaction.mockImplementation(
      (callback) =>
        callback({
          save: readingRepo.save,
          increment: jest.fn((entity, where, column, value) =>
            batchRepo.increment(where, column, value),
          ),
        }),
    );

    // Setup resolveBatch mocks
    const fakeBatchRow = {
      id: 'batch-1',
      project_id: 'proj-1',
      status: BatchStatus.PENDING,
      reading_count: 0,
      created_at: new Date(),
      updated_at: new Date(),
    };
    dataSource.query
      .mockResolvedValueOnce(undefined) // UPDATE stale
      .mockResolvedValueOnce(undefined) // INSERT ON CONFLICT
      .mockResolvedValueOnce([fakeBatchRow]); // SELECT PENDING
    batchRepo.create.mockImplementation((d) => d as ReadingBatch);
  });

  it('skips validation for unknown parameter keys (not in PARAMETER_RANGES)', async () => {
    const device = {
      id: 'device-uuid-1',
      deviceId: 'dev-001',
      projectId: 'proj-1',
      publicKey: testKeypair.publicKey(),
    } as SensorDevice;
    deviceRepo.findOne.mockResolvedValue(device);

    const payload = buildPayload('dev-001', new Date().toISOString(), {
      ph: 7.0,
      turbidity: null,
      dissolvedOxygen: null,
      flowRate: null,
      nitrogen: null,
      phosphorus: null,
      temperature: null,
    });
    const signature = signPayload(testKeypair, payload);

    const batchRow = {
      id: 'batch-1',
      project_id: 'proj-1',
      status: BatchStatus.PENDING,
      reading_count: 0,
      created_at: new Date(),
      updated_at: new Date(),
    };
    dataSource.query
      .mockResolvedValueOnce(undefined) // UPDATE stale
      .mockResolvedValueOnce(undefined) // INSERT ON CONFLICT
      .mockResolvedValueOnce([batchRow]); // SELECT PENDING
    batchRepo.create.mockImplementation((d) => d as ReadingBatch);
    readingRepo.create.mockImplementation((d) => d as SensorReading);
    readingRepo.save.mockImplementation((r) =>
      Promise.resolve({ ...r, id: 'r-1' } as SensorReading),
    );
    deviceRepo.update.mockResolvedValue(undefined);
    batchRepo.increment.mockResolvedValue(undefined);

    const result = await service.ingestReading({
      deviceId: 'dev-001',
      timestamp: new Date().toISOString(),
      ph: 7.0,
      someUnknownParam: 999 as never,
      signature,
    } as CreateReadingDto);

    expect(result).toBeDefined();
  });
});
