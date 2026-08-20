import { Test, TestingModule } from '@nestjs/testing';
import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { getRepositoryToken } from '@nestjs/typeorm';
import { SensorsController } from './sensors.controller';
import { SensorsService } from './sensors.service';
import { ApiKeyGuard } from '../../common/guards/api-key.guard';
import { SensorDevice } from './entities/sensor-device.entity';
import { CreateReadingDto } from './dto/create-reading.dto';
import * as bcrypt from 'bcryptjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDevice(overrides: Partial<SensorDevice> = {}): SensorDevice {
  return {
    id: 'uuid-device-1',
    projectId: 'proj-1',
    deviceId: 'sensor-gv-001',
    manufacturer: 'YSI',
    model: 'ProDSS',
    parameters: null,
    publicKey: 'GABC',
    apiKeyHash: null,
    isActive: true,
    lastReadingAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    project: null as never,
    ...overrides,
  } as SensorDevice;
}

/**
 * Builds a minimal ExecutionContext that ApiKeyGuard can interrogate.
 * The Reflector mock always returns `true` so the guard treats every
 * route as requiring an API key.
 */
function buildContext(
  apiKey: string | undefined,
  bodyDeviceId: string | undefined,
): ExecutionContext {
  const request = {
    headers: apiKey ? { 'x-api-key': apiKey } : {},
    body: bodyDeviceId !== undefined ? { deviceId: bodyDeviceId } : {},
    sensorDevice: undefined as SensorDevice | undefined,
  };
  return {
    getHandler: () => SensorsController.prototype.ingestReading,
    getClass: () => SensorsController,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

/**
 * Builds a mock deviceRepo whose createQueryBuilder chain returns `device`.
 */
function makeDeviceRepo(device: SensorDevice | null) {
  const qb = {
    addSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    getOne: jest.fn().mockResolvedValue(device),
  };
  return {
    createQueryBuilder: jest.fn().mockReturnValue(qb),
    _qb: qb, // expose for assertions
  };
}

// ---------------------------------------------------------------------------
// ApiKeyGuard unit tests (covers acceptance criteria)
// ---------------------------------------------------------------------------

describe('ApiKeyGuard', () => {
  const validSecret = 'a'.repeat(64);
  const validDeviceId = 'sensor-gv-001';
  const validKey = `wc_${validDeviceId}_${validSecret}`;
  let validHash: string;

  beforeAll(async () => {
    validHash = await bcrypt.hash(validSecret, 10);
  });

  function makeGuard(deviceRepo: ReturnType<typeof makeDeviceRepo>): ApiKeyGuard {
    const reflector = {
      getAllAndOverride: jest.fn().mockReturnValue(true),
    } as unknown as Reflector;
    return new ApiKeyGuard(reflector, deviceRepo as never);
  }

  // ── AC1: valid key + correct deviceId → accepted ────────────────────────

  it('AC1 – accepts a valid key bound to the matching device', async () => {
    const device = makeDevice({ deviceId: validDeviceId, apiKeyHash: validHash });
    const repo = makeDeviceRepo(device);
    const guard = makeGuard(repo);

    const ctx = buildContext(validKey, validDeviceId);
    const result = await guard.canActivate(ctx);

    expect(result).toBe(true);
  });

  // ── AC2: valid key for device A cannot authenticate reading for device B ─

  it('AC2 – rejects when key deviceId and body deviceId differ', async () => {
    const device = makeDevice({ deviceId: validDeviceId, apiKeyHash: validHash });
    const repo = makeDeviceRepo(device);
    const guard = makeGuard(repo);

    // Key says sensor-gv-001, body says sensor-gv-002
    const ctx = buildContext(validKey, 'sensor-gv-002');

    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });

  // ── AC3: invalid key + correct deviceId → rejected ──────────────────────

  it('AC3 – rejects an invalid secret for a known device', async () => {
    const device = makeDevice({ deviceId: validDeviceId, apiKeyHash: validHash });
    const repo = makeDeviceRepo(device);
    const guard = makeGuard(repo);

    const wrongKey = `wc_${validDeviceId}_${'b'.repeat(64)}`;
    const ctx = buildContext(wrongKey, validDeviceId);

    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });

  // ── AC4: unknown deviceId → rejected ────────────────────────────────────

  it('AC4 – rejects an unknown deviceId (device not found)', async () => {
    const repo = makeDeviceRepo(null); // device not found
    const guard = makeGuard(repo);

    const ctx = buildContext(validKey, 'unknown-device');
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });

  // ── AC5: missing header → rejected ──────────────────────────────────────

  it('AC5 – rejects when X-API-Key header is absent', async () => {
    const repo = makeDeviceRepo(null);
    const guard = makeGuard(repo);

    const ctx = buildContext(undefined, validDeviceId);
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });

  // ── AC6: malformed key → rejected ───────────────────────────────────────

  it('AC6 – rejects a key that does not match wc_<id>_<secret> format', async () => {
    const repo = makeDeviceRepo(null);
    const guard = makeGuard(repo);

    const ctx = buildContext('not-a-valid-key', validDeviceId);
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });

  // ── AC7: deviceId containing underscores is handled correctly ───────────

  it('AC7 – correctly handles a deviceId that contains underscores', async () => {
    const underscoredId = 'sensor_gv_001';
    const key = `wc_${underscoredId}_${validSecret}`;
    const device = makeDevice({ deviceId: underscoredId, apiKeyHash: validHash });
    const repo = makeDeviceRepo(device);
    const guard = makeGuard(repo);

    const ctx = buildContext(key, underscoredId);
    const result = await guard.canActivate(ctx);

    expect(result).toBe(true);
    // Confirm the guard correctly re-assembled the deviceId from the key
    expect(repo._qb.where).toHaveBeenCalledWith('d.deviceId = :deviceId', {
      deviceId: underscoredId,
    });
  });

  // ── AC8: unknown deviceId still runs bcrypt (timing safety) ─────────────

  it('AC8 – still calls bcrypt.compare on an unknown device (timing safety)', async () => {
    const repo = makeDeviceRepo(null);
    const guard = makeGuard(repo);
    const compareSpy = jest.spyOn(bcrypt, 'compare');

    const ctx = buildContext(validKey, 'ghost-device');
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);

    expect(compareSpy).toHaveBeenCalled();
    compareSpy.mockRestore();
  });

  // ── AC9: guard has no ConfigService dependency ───────────────────────────

  it('AC9 – guard has no ConfigService injected (global key fully removed)', () => {
    const repo = makeDeviceRepo(null);
    const guard = makeGuard(repo);
    expect((guard as unknown as Record<string, unknown>).configService).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// SensorsController wiring tests
// ---------------------------------------------------------------------------

describe('SensorsController – ingestReading wiring', () => {
  let controller: SensorsController;
  const mockIngestReading = jest.fn();

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [SensorsController],
      providers: [
        {
          provide: SensorsService,
          useValue: {
            ingestReading: mockIngestReading,
            getReadings: jest.fn(),
            getLatestReading: jest.fn(),
            getAggregatedSummary: jest.fn(),
            registerDevice: jest.fn(),
            getDevices: jest.fn(),
            getDeviceById: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(SensorDevice),
          useValue: {
            createQueryBuilder: jest.fn().mockReturnValue({
              addSelect: jest.fn().mockReturnThis(),
              where: jest.fn().mockReturnThis(),
              getOne: jest.fn().mockResolvedValue(null),
            }),
          },
        },
        Reflector,
        ApiKeyGuard,
      ],
    })
      // Override the guard so the handler can be tested in isolation
      .overrideGuard(ApiKeyGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<SensorsController>(SensorsController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('AC10 – delegates to sensorsService.ingestReading when guard passes', async () => {
    const dto: CreateReadingDto = {
      deviceId: 'sensor-gv-001',
      timestamp: new Date().toISOString(),
      ph: 7.2,
      signature: 'sig==',
    };
    const reading = { id: 'r1', ...dto };
    mockIngestReading.mockResolvedValue(reading);

    const result = await controller.ingestReading(dto);
    expect(mockIngestReading).toHaveBeenCalledWith(dto);
    expect(result).toBe(reading);
  });

  it('AC11 – controller has no ConfigService dependency (global key removed)', () => {
    expect((controller as unknown as Record<string, unknown>).configService).toBeUndefined();
  });

  it('passes the authenticated user context to protected sensor reads', async () => {
    const query = { projectId: 'project-a' } as never;
    const getReadings = (controller as unknown as { sensorsService: { getReadings: jest.Mock } })
      .sensorsService.getReadings;
    getReadings.mockResolvedValue({ data: [], total: 0, page: 1, limit: 20 });

    await controller.getReadings(query, 'user-a', 'farmer');

    expect(getReadings).toHaveBeenCalledWith(query, 'user-a', 'farmer');
  });

  it('passes userId and role to registerDevice for project ownership check', async () => {
    const registerDevice = (controller as unknown as { sensorsService: { registerDevice: jest.Mock } })
      .sensorsService.registerDevice;
    const deviceResult = { id: 'dev-1', apiKeyPlaintext: 'wc_x_y' };
    registerDevice.mockResolvedValue(deviceResult);

    const dto = { projectId: 'proj-1', deviceId: 'dev-001', manufacturer: 'YSI', model: 'ProDSS', publicKey: 'G'.padEnd(56, 'A'), parameters: ['ph'] } as never;
    const result = await controller.registerDevice(dto, 'user-a', 'farmer');

    expect(registerDevice).toHaveBeenCalledWith('proj-1', dto, 'user-a', 'farmer');
    expect(result).toBe(deviceResult);
  });
});
