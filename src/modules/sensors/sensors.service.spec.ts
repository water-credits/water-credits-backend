import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Keypair } from '@stellar/stellar-sdk';
import { SensorsService } from './sensors.service';
import { SensorDevice } from './entities/sensor-device.entity';
import { SensorReading } from './entities/sensor-reading.entity';
import { ReadingBatch, BatchStatus } from './entities/reading-batch.entity';
import { CreateReadingDto } from './dto/create-reading.dto';
import { TimeSeriesQueryDto, SensorParameter } from './dto/time-series-query.dto';

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

// ── Test suite ────────────────────────────────────────────────────────────────

describe('SensorsService', () => {
  let service: SensorsService;
  let deviceRepo: MockRepo;
  let readingRepo: MockRepo;
  let batchRepo: MockRepo;

  // A real Stellar keypair used for signature tests — generated once per suite.
  let testKeypair: Keypair;

  beforeAll(() => {
    testKeypair = Keypair.random();
  });

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
      ],
    }).compile();

    service = module.get<SensorsService>(SensorsService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  // ── verifySignature (via ingestReading) ──────────────────────────────────

  describe('ingestReading — signature verification', () => {
    const TIMESTAMP = '2026-01-01T00:00:00.000Z';
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
    });

    it('accepts a valid ECDSA signature (real keypair, no mock)', async () => {
      const payload = buildPayload('dev-001', TIMESTAMP, PARAMS);
      const signature = signPayload(testKeypair, payload);

      const fakeBatch: Partial<ReadingBatch> = {
        id: 'batch-1',
        projectId: 'proj-1',
        status: BatchStatus.PENDING,
        createdAt: new Date(),
      };
      batchRepo.findOne.mockResolvedValue(fakeBatch);
      batchRepo.create.mockImplementation((d) => d as ReadingBatch);
      batchRepo.save.mockImplementation((b) =>
        Promise.resolve({ ...b, id: 'batch-1' } as ReadingBatch),
      );

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
        timestamp: '2026-01-01T00:00:00.000Z',
        ph: 15, // out of range
        signature: 'aGVsbG8=',
      };

      await expect(service.ingestReading(dto)).rejects.toThrow(BadRequestException);
      await expect(service.ingestReading(dto)).rejects.toThrow("'ph'");
    });

    it('throws BadRequestException when ph is below 0', async () => {
      const dto: CreateReadingDto = {
        deviceId: 'dev-001',
        timestamp: '2026-01-01T00:00:00.000Z',
        ph: -1,
        signature: 'aGVsbG8=',
      };

      await expect(service.ingestReading(dto)).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException when temperature exceeds 100', async () => {
      const dto: CreateReadingDto = {
        deviceId: 'dev-001',
        timestamp: '2026-01-01T00:00:00.000Z',
        temperature: 101,
        signature: 'aGVsbG8=',
      };

      await expect(service.ingestReading(dto)).rejects.toThrow(BadRequestException);
      await expect(service.ingestReading(dto)).rejects.toThrow("'temperature'");
    });

    it('throws BadRequestException when temperature is below -50', async () => {
      const dto: CreateReadingDto = {
        deviceId: 'dev-001',
        timestamp: '2026-01-01T00:00:00.000Z',
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
        timestamp: '2026-01-01T00:00:00.000Z',
        ph: 0,
        signature: 'aGVsbG8=',
      };
      // Expect BadRequestException from signature (not from validation)
      await expect(service.ingestReading(dtoMin)).rejects.toThrow('Invalid reading signature');

      const dtoMax: CreateReadingDto = {
        deviceId: 'dev-001',
        timestamp: '2026-01-01T00:00:00.000Z',
        ph: 14,
        signature: 'aGVsbG8=',
      };
      await expect(service.ingestReading(dtoMax)).rejects.toThrow('Invalid reading signature');
    });

    it('skips validation for null/undefined optional parameters', async () => {
      const dto: CreateReadingDto = {
        deviceId: 'dev-001',
        timestamp: '2026-01-01T00:00:00.000Z',
        // all optional params omitted → all null
        signature: 'aGVsbG8=',
      };
      // Validation passes; only the signature is rejected.
      await expect(service.ingestReading(dto)).rejects.toThrow('Invalid reading signature');
    });
  });

  // ── resolveBatch — 15-minute window boundary ─────────────────────────────

  describe('ingestReading — batch window boundary (resolveBatch)', () => {
    const TIMESTAMP = '2026-01-01T00:00:00.000Z';

    let fakeDevice: SensorDevice;
    let validSignature: string;

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

    it('reuses a PENDING batch created within the last 15 minutes', async () => {
      const recentBatch: Partial<ReadingBatch> = {
        id: 'batch-recent',
        projectId: 'proj-1',
        status: BatchStatus.PENDING,
        // Created just 1 minute ago — well within the window
        createdAt: new Date(Date.now() - 60_000),
      };

      batchRepo.findOne.mockResolvedValue(recentBatch);
      batchRepo.create.mockImplementation((d) => d as ReadingBatch);
      batchRepo.save.mockImplementation((b) =>
        Promise.resolve({ ...b, id: 'batch-new' } as ReadingBatch),
      );

      await service.ingestReading({
        deviceId: 'dev-001',
        timestamp: TIMESTAMP,
        signature: validSignature,
      });

      // A new batch should NOT have been created; only increment was called.
      expect(batchRepo.save).not.toHaveBeenCalled();
      expect(batchRepo.increment).toHaveBeenCalledWith({ id: 'batch-recent' }, 'readingCount', 1);
    });

    it('creates a new batch when the existing PENDING batch is older than 15 minutes', async () => {
      const staleBatch: Partial<ReadingBatch> = {
        id: 'batch-stale',
        projectId: 'proj-1',
        status: BatchStatus.PENDING,
        // Created 16 minutes ago — outside the 15-minute window
        createdAt: new Date(Date.now() - 16 * 60_000),
      };

      const newBatch: Partial<ReadingBatch> = {
        id: 'batch-new',
        projectId: 'proj-1',
        status: BatchStatus.PENDING,
        createdAt: new Date(),
      };

      batchRepo.findOne.mockResolvedValue(staleBatch);
      batchRepo.create.mockReturnValue(newBatch as ReadingBatch);
      batchRepo.save.mockResolvedValue(newBatch as ReadingBatch);

      await service.ingestReading({
        deviceId: 'dev-001',
        timestamp: TIMESTAMP,
        signature: validSignature,
      });

      // A brand-new batch was saved.
      expect(batchRepo.save).toHaveBeenCalled();
      expect(batchRepo.increment).toHaveBeenCalledWith({ id: 'batch-new' }, 'readingCount', 1);
    });

    it('creates a new batch when no PENDING batch exists at all', async () => {
      batchRepo.findOne.mockResolvedValue(null);

      const newBatch: Partial<ReadingBatch> = {
        id: 'batch-fresh',
        projectId: 'proj-1',
        status: BatchStatus.PENDING,
        createdAt: new Date(),
      };

      batchRepo.create.mockReturnValue(newBatch as ReadingBatch);
      batchRepo.save.mockResolvedValue(newBatch as ReadingBatch);

      await service.ingestReading({
        deviceId: 'dev-001',
        timestamp: TIMESTAMP,
        signature: validSignature,
      });

      expect(batchRepo.save).toHaveBeenCalled();
    });

    it('uses exactly the 15-minute boundary: a batch created precisely at cutoff is reused (not expired)', async () => {
      // We freeze time so that Date.now() inside resolveBatch() returns the same
      // value as when we create the batch timestamp below.
      jest.useFakeTimers();
      const FROZEN_NOW = 1_700_000_000_000;
      jest.setSystemTime(FROZEN_NOW);

      // cutoff = FROZEN_NOW - 15*60*1000
      // batch.createdAt = exactly cutoff → satisfies `createdAt >= cutoff` → reused.
      const exactCutoffTime = FROZEN_NOW - 15 * 60_000;
      const cutoffBatch: Partial<ReadingBatch> = {
        id: 'batch-cutoff',
        projectId: 'proj-1',
        status: BatchStatus.PENDING,
        createdAt: new Date(exactCutoffTime),
      };

      const newBatch: Partial<ReadingBatch> = {
        id: 'batch-new',
        projectId: 'proj-1',
        status: BatchStatus.PENDING,
        createdAt: new Date(FROZEN_NOW),
      };

      batchRepo.findOne.mockResolvedValue(cutoffBatch);
      batchRepo.create.mockReturnValue(newBatch as ReadingBatch);
      batchRepo.save.mockResolvedValue(newBatch as ReadingBatch);

      await service.ingestReading({
        deviceId: 'dev-001',
        timestamp: TIMESTAMP,
        signature: validSignature,
      });

      jest.useRealTimers();

      // Batch at exactly cutoff satisfies `>= cutoff`, so no new batch is created.
      expect(batchRepo.save).not.toHaveBeenCalled();
      expect(batchRepo.increment).toHaveBeenCalledWith({ id: 'batch-cutoff' }, 'readingCount', 1);
    });

    it('creates a new batch when the existing batch is 1ms beyond the cutoff (strictly expired)', async () => {
      // Freeze time for a deterministic cutoff.
      jest.useFakeTimers();
      const FROZEN_NOW = 1_700_000_000_000;
      jest.setSystemTime(FROZEN_NOW);

      // 1ms before cutoff → does NOT satisfy `>= cutoff` → new batch.
      const expiredTime = FROZEN_NOW - 15 * 60_000 - 1;
      const expiredBatch: Partial<ReadingBatch> = {
        id: 'batch-expired',
        projectId: 'proj-1',
        status: BatchStatus.PENDING,
        createdAt: new Date(expiredTime),
      };

      const newBatch: Partial<ReadingBatch> = {
        id: 'batch-new-2',
        projectId: 'proj-1',
        status: BatchStatus.PENDING,
        createdAt: new Date(FROZEN_NOW),
      };

      batchRepo.findOne.mockResolvedValue(expiredBatch);
      batchRepo.create.mockReturnValue(newBatch as ReadingBatch);
      batchRepo.save.mockResolvedValue(newBatch as ReadingBatch);

      await service.ingestReading({
        deviceId: 'dev-001',
        timestamp: TIMESTAMP,
        signature: validSignature,
      });

      jest.useRealTimers();

      expect(batchRepo.save).toHaveBeenCalled();
      expect(batchRepo.increment).toHaveBeenCalledWith({ id: 'batch-new-2' }, 'readingCount', 1);
    });
  });

  // ── getLatestReading — N+1 documentation ────────────────────────────────

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
        timestamp: new Date('2026-01-01T01:00:00Z'),
      };

      deviceRepo.findOne.mockResolvedValue(fakeDevice as SensorDevice);
      readingRepo.findOne.mockResolvedValue(fakeReading as SensorReading);

      const result = await service.getLatestReading('dev-001');

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

      await expect(service.getLatestReading('dev-001')).rejects.toThrow(NotFoundException);
    });

    // TODO: N+1 — replace with a single query that fetches the latest reading
    // per device in one round-trip (e.g. a DISTINCT ON (device_id) query or a
    // subquery join). When getLatestReading() is called without a deviceId it
    // currently issues one findOne per device returned by deviceRepo.find(),
    // which is O(n) database queries for n devices.
    it.todo(
      'getLatestReading() without deviceId should fetch all latest readings in a single query instead of one findOne per device',
    );

    it('returns an array of latest readings (one per device) when no deviceId is given', async () => {
      const devices: Partial<SensorDevice>[] = [
        { id: 'dev-uuid-1', deviceId: 'dev-001', projectId: 'proj-1', publicKey: '' },
        { id: 'dev-uuid-2', deviceId: 'dev-002', projectId: 'proj-1', publicKey: '' },
      ];
      const readings: Partial<SensorReading>[] = [
        { id: 'r-1', deviceId: 'dev-uuid-1', ph: 7.0 },
        { id: 'r-2', deviceId: 'dev-uuid-2', ph: 6.8 },
      ];

      deviceRepo.find.mockResolvedValue(devices as SensorDevice[]);
      readingRepo.findOne
        .mockResolvedValueOnce(readings[0] as SensorReading)
        .mockResolvedValueOnce(readings[1] as SensorReading);

      const result = await service.getLatestReading();

      // N+1: one findOne call issued per device
      expect(readingRepo.findOne).toHaveBeenCalledTimes(2);
      expect(result).toHaveLength(2);
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

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SensorsService,
        { provide: getRepositoryToken(SensorDevice), useValue: deviceRepo },
        { provide: getRepositoryToken(SensorReading), useValue: readingRepo },
        { provide: getRepositoryToken(ReadingBatch), useValue: batchRepo },
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
    const result = await service.registerDevice('proj-1', dto as never);

    expect(deviceRepo.save).toHaveBeenCalled();
    expect(result.apiKeyPlaintext).toBeDefined();
    expect(result.apiKeyPlaintext).toMatch(/^wc_dev-new-001_/);
  });

  it('throws BadRequestException when deviceId is already registered', async () => {
    const existing = { id: 'device-uuid-existing', deviceId: BASE_DTO.deviceId } as SensorDevice;
    deviceRepo.findOne.mockResolvedValue(existing);

    const dto = { ...BASE_DTO, publicKey: testKeypair.publicKey() };
    await expect(service.registerDevice('proj-1', dto as never)).rejects.toThrow(
      BadRequestException,
    );
    await expect(service.registerDevice('proj-1', dto as never)).rejects.toThrow(
      'already registered',
    );
  });

  it('filters devices by projectId', async () => {
    const devices = [{ id: 'dev-1', projectId: 'proj-1' }] as SensorDevice[];
    deviceRepo.find.mockResolvedValue(devices);

    const result = await service.getDevices('proj-1');
    expect(result).toEqual(devices);
    expect(deviceRepo.find).toHaveBeenCalledWith({ where: { projectId: 'proj-1' } });
  });

  it('returns all devices when no projectId is given', async () => {
    const devices = [{ id: 'dev-1' }, { id: 'dev-2' }] as SensorDevice[];
    deviceRepo.find.mockResolvedValue(devices);

    const result = await service.getDevices();
    expect(result).toHaveLength(2);
    expect(deviceRepo.find).toHaveBeenCalledWith({ order: { createdAt: 'DESC' } });
  });

  it('getDeviceById returns device when found', async () => {
    const device = { id: 'device-uuid-1', deviceId: 'dev-001' } as SensorDevice;
    deviceRepo.findOne.mockResolvedValue(device);

    const result = await service.getDeviceById('device-uuid-1');
    expect(result).toEqual(device);
  });

  it('getDeviceById throws NotFoundException when device is not found', async () => {
    deviceRepo.findOne.mockResolvedValue(null);
    await expect(service.getDeviceById('nonexistent')).rejects.toThrow(NotFoundException);
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
      ],
    }).compile();

    service = module.get<SensorsService>(SensorsService);
  });

  it('returns paginated readings with no filters', async () => {
    const qb = makeQb();
    readingRepo.createQueryBuilder.mockReturnValue(qb);

    const result = await service.getReadings({ skip: 0, limit: 20, page: 1 } as never);

    expect(qb.getManyAndCount).toHaveBeenCalled();
    expect(result.page).toBe(1);
    expect(result.limit).toBe(20);
  });

  it('filters by deviceId when provided', async () => {
    const qb = makeQb();
    readingRepo.createQueryBuilder.mockReturnValue(qb);

    await service.getReadings({ deviceId: 'dev-001', skip: 0, limit: 20, page: 1 } as never);

    expect(qb.andWhere).toHaveBeenCalledWith(
      expect.stringContaining('device_id'),
      expect.any(Object),
    );
  });

  it('filters by projectId when provided', async () => {
    const qb = makeQb();
    readingRepo.createQueryBuilder.mockReturnValue(qb);

    await service.getReadings({ projectId: 'proj-1', skip: 0, limit: 20, page: 1 } as never);

    expect(qb.andWhere).toHaveBeenCalledWith(
      expect.stringContaining('project_id'),
      expect.any(Object),
    );
  });

  it('filters by startDate and endDate when provided', async () => {
    const qb = makeQb();
    readingRepo.createQueryBuilder.mockReturnValue(qb);

    await service.getReadings({
      startDate: '2026-01-01',
      endDate: '2026-12-31',
      skip: 0,
      limit: 20,
      page: 1,
    } as never);

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
  let testKeypair: Keypair;

  beforeAll(() => {
    testKeypair = Keypair.random();
  });

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
      ],
    }).compile();

    service = module.get<SensorsService>(SensorsService);
  });

  it('skips validation for unknown parameter keys (not in PARAMETER_RANGES)', async () => {
    const device = {
      id: 'device-uuid-1',
      deviceId: 'dev-001',
      projectId: 'proj-1',
      publicKey: testKeypair.publicKey(),
    } as SensorDevice;
    deviceRepo.findOne.mockResolvedValue(device);

    const payload = buildPayload('dev-001', '2026-01-01T00:00:00.000Z', {
      ph: 7.0,
      turbidity: null,
      dissolvedOxygen: null,
      flowRate: null,
      nitrogen: null,
      phosphorus: null,
      temperature: null,
    });
    const signature = signPayload(testKeypair, payload);

    const batch = {
      id: 'batch-1',
      projectId: 'proj-1',
      status: BatchStatus.PENDING,
      createdAt: new Date(),
    };
    batchRepo.findOne.mockResolvedValue(batch);
    readingRepo.create.mockImplementation((d) => d as SensorReading);
    readingRepo.save.mockImplementation((r) =>
      Promise.resolve({ ...r, id: 'r-1' } as SensorReading),
    );
    deviceRepo.update.mockResolvedValue(undefined);
    batchRepo.increment.mockResolvedValue(undefined);

    const result = await service.ingestReading({
      deviceId: 'dev-001',
      timestamp: '2026-01-01T00:00:00.000Z',
      ph: 7.0,
      someUnknownParam: 999 as never,
      signature,
    } as CreateReadingDto);

    expect(result).toBeDefined();
  });
});

describe('SensorsService — getTimeSeriesData', () => {
  let service: SensorsService;
  let deviceRepo: MockRepo;
  let readingRepo: MockRepo;
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
      ],
    }).compile();

    service = module.get<SensorsService>(SensorsService);
  });

  it('should return time-series data with correct structure', async () => {
    const mockResults = [
      {
        bucket: '2026-01-01T00:00:00.000Z',
        avg: '7.5',
        min: '7.0',
        max: '8.0',
        count: '10',
      },
      {
        bucket: '2026-01-02T00:00:00.000Z',
        avg: '7.8',
        min: '7.2',
        max: '8.5',
        count: '15',
      },
    ];

    const qb = {
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      setParameter: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue(mockResults),
    };
    readingRepo.createQueryBuilder.mockReturnValue(qb);

    const dto: TimeSeriesQueryDto = {
      parameter: SensorParameter.PH,
      bucket: 'day' as any,
      startDate: '2026-01-01',
      endDate: '2026-01-31',
    };

    const result = await service.getTimeSeriesData('proj-1', dto);

    expect(result.data).toHaveLength(2);
    expect(result.data[0]).toEqual({
      bucket: '2026-01-01T00:00:00.000Z',
      avg: 7.5,
      min: 7.0,
      max: 8.0,
      count: 10,
    });
    expect(result.truncated).toBe(false);
    expect(result.total).toBe(2);
  });

  it('should use parameterised bucket in DATE_TRUNC', async () => {
    const qb = {
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      setParameter: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([]),
    };
    readingRepo.createQueryBuilder.mockReturnValue(qb);

    const dto: TimeSeriesQueryDto = {
      parameter: SensorParameter.PH,
      bucket: 'day' as any,
      startDate: '2026-01-01',
      endDate: '2026-01-31',
    };

    await service.getTimeSeriesData('proj-1', dto);

    expect(qb.setParameter).toHaveBeenCalledWith('bucket', 'day');
    expect(qb.groupBy).toHaveBeenCalledWith(expect.stringContaining('DATE_TRUNC(:bucket'));
  });

  it('should map parameter enum to correct database column', async () => {
    const qb = {
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      setParameter: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([]),
    };
    readingRepo.createQueryBuilder.mockReturnValue(qb);

    const dto: TimeSeriesQueryDto = {
      parameter: SensorParameter.DISSOLVED_OXYGEN,
      bucket: 'day' as any,
      startDate: '2026-01-01',
      endDate: '2026-01-31',
    };

    await service.getTimeSeriesData('proj-1', dto);

    expect(qb.addSelect).toHaveBeenCalledWith(expect.stringContaining('dissolved_oxygen'), 'avg');
    expect(qb.addSelect).toHaveBeenCalledWith(expect.stringContaining('dissolved_oxygen'), 'min');
    expect(qb.addSelect).toHaveBeenCalledWith(expect.stringContaining('dissolved_oxygen'), 'max');
  });

  it('should truncate results when exceeding MAX_BUCKETS', async () => {
    const largeResults = Array.from({ length: 1500 }, (_, i) => ({
      bucket: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`,
      avg: '7.0',
      min: '6.5',
      max: '7.5',
      count: '10',
    }));

    const qb = {
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      setParameter: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue(largeResults),
    };
    readingRepo.createQueryBuilder.mockReturnValue(qb);

    const dto: TimeSeriesQueryDto = {
      parameter: SensorParameter.PH,
      bucket: 'hour' as any,
      startDate: '2026-01-01',
      endDate: '2026-12-31',
    };

    const result = await service.getTimeSeriesData('proj-1', dto);

    expect(result.data).toHaveLength(1000);
    expect(result.truncated).toBe(true);
    expect(result.total).toBe(1500);
  });

  it('should filter by projectId and date range', async () => {
    const qb = {
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      setParameter: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([]),
    };
    readingRepo.createQueryBuilder.mockReturnValue(qb);

    const dto: TimeSeriesQueryDto = {
      parameter: SensorParameter.PH,
      bucket: 'day' as any,
      startDate: '2026-01-01',
      endDate: '2026-01-31',
    };

    await service.getTimeSeriesData('proj-123', dto);

    expect(qb.where).toHaveBeenCalledWith('reading.project_id = :projectId', { projectId: 'proj-123' });
    expect(qb.andWhere).toHaveBeenCalledWith('reading.timestamp >= :startDate', { startDate: '2026-01-01' });
    expect(qb.andWhere).toHaveBeenCalledWith('reading.timestamp <= :endDate', { endDate: '2026-01-31' });
  });
});
