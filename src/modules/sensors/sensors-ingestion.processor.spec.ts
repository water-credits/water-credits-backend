import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { SensorsIngestionProcessor, SensorIngestionJobData } from './sensors-ingestion.processor';
import { SensorReading } from './entities/sensor-reading.entity';
import { GovernanceConfig } from '../governance/entities/governance-config.entity';
import { SensorsGateway } from './sensors.gateway';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeReading(overrides: Partial<SensorReading> = {}): SensorReading {
  return {
    id: 'reading-uuid-1',
    deviceId: 'device-uuid-1',
    projectId: 'proj-1',
    timestamp: new Date('2026-01-01T00:00:00.000Z'),
    ph: 7.0,
    turbidity: null,
    dissolvedOxygen: null,
    flowRate: null,
    nitrogen: null,
    phosphorus: null,
    temperature: 20,
    signature: 'sig',
    isVerified: true,
    wsEmittedAt: null,
    batchId: 'batch-1',
    createdAt: new Date('2026-01-01T00:00:01.000Z'),
    ...overrides,
  } as SensorReading;
}

function makeJob(overrides: Partial<SensorIngestionJobData> = {}): never {
  return {
    data: {
      readingId: 'reading-uuid-1',
      deviceId: 'device-uuid-1',
      projectId: 'proj-1',
      ...overrides,
    },
  } as never;
}

function makeConfig(overrides: Partial<GovernanceConfig> = {}): GovernanceConfig {
  return {
    id: 1,
    protocolFeeBps: 100,
    minOracleConfirmations: 3,
    votingPeriod: 604800,
    timelockPeriod: 86400,
    quorum: 3,
    phMin: 6.5,
    phMax: 8.5,
    doThreshold: 5.0,
    tempPenaltyDelta: 2.0,
    weightVolumetric: 0.5,
    weightNitrogen: 0.3,
    weightPhosphorus: 0.2,
    updatedBy: null,
    updatedAt: new Date(),
    ...overrides,
  } as GovernanceConfig;
}

// ── Suite ────────────────────────────────────────────────────────────────────

describe('SensorsIngestionProcessor', () => {
  let processor: SensorsIngestionProcessor;

  let readingRepo: { findOne: jest.Mock; save: jest.Mock };
  let configRepo: { findOne: jest.Mock };
  let gateway: { emitReading: jest.Mock; emitAlert: jest.Mock };

  beforeEach(async () => {
    readingRepo = { findOne: jest.fn(), save: jest.fn() };
    configRepo = { findOne: jest.fn() };
    gateway = { emitReading: jest.fn(), emitAlert: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SensorsIngestionProcessor,
        { provide: getRepositoryToken(SensorReading), useValue: readingRepo },
        { provide: getRepositoryToken(GovernanceConfig), useValue: configRepo },
        { provide: SensorsGateway, useValue: gateway },
      ],
    }).compile();

    processor = module.get<SensorsIngestionProcessor>(SensorsIngestionProcessor);
  });

  it('should be defined', () => {
    expect(processor).toBeDefined();
  });

  describe('successful emit', () => {
    it('loads the reading, emits sensor:reading and persists wsEmittedAt', async () => {
      const reading = makeReading();
      readingRepo.findOne.mockResolvedValue(reading);
      configRepo.findOne.mockResolvedValue(makeConfig());
      readingRepo.save.mockImplementation((r) => Promise.resolve(r));

      await expect(processor.processReading(makeJob())).resolves.toBeUndefined();

      // Reading broadcast to the project room with the full payload.
      expect(gateway.emitReading).toHaveBeenCalledTimes(1);
      expect(gateway.emitReading).toHaveBeenCalledWith(
        'proj-1',
        expect.objectContaining({
          id: 'reading-uuid-1',
          deviceId: 'device-uuid-1',
          projectId: 'proj-1',
          ph: 7.0,
          temperature: 20,
          isVerified: true,
          batchId: 'batch-1',
        }),
      );

      // Idempotency marker persisted.
      expect(readingRepo.save).toHaveBeenCalledTimes(1);
      const saved = readingRepo.save.mock.calls[0][0] as SensorReading;
      expect(saved.wsEmittedAt).toBeInstanceOf(Date);
    });

    it('emits no alerts for in-range parameters', async () => {
      readingRepo.findOne.mockResolvedValue(makeReading());
      configRepo.findOne.mockResolvedValue(makeConfig());

      await processor.processReading(makeJob());

      expect(gateway.emitAlert).not.toHaveBeenCalled();
    });

    it('ignores null/undefined parameters during alert evaluation', async () => {
      readingRepo.findOne.mockResolvedValue(
        makeReading({
          ph: null,
          turbidity: undefined as never,
          dissolvedOxygen: null,
          flowRate: null,
          nitrogen: null,
          phosphorus: null,
          temperature: null,
        }),
      );
      configRepo.findOne.mockResolvedValue(makeConfig());

      await processor.processReading(makeJob());

      expect(gateway.emitReading).toHaveBeenCalledTimes(1);
      expect(gateway.emitAlert).not.toHaveBeenCalled();
    });
  });

  describe('threshold-breach alerts', () => {
    it('emits sensor:alert when pH drops below the governance phMin', async () => {
      readingRepo.findOne.mockResolvedValue(makeReading({ ph: 5.5 }));
      configRepo.findOne.mockResolvedValue(makeConfig({ phMin: 6.5, phMax: 8.5 }));

      await processor.processReading(makeJob());

      expect(gateway.emitAlert).toHaveBeenCalledTimes(1);
      expect(gateway.emitAlert).toHaveBeenCalledWith('proj-1', {
        projectId: 'proj-1',
        deviceId: 'device-uuid-1',
        parameter: 'ph',
        value: 5.5,
        threshold: 6.5,
        direction: 'below',
      });
    });

    it('emits sensor:alert when pH exceeds the governance phMax', async () => {
      readingRepo.findOne.mockResolvedValue(makeReading({ ph: 9.2 }));
      configRepo.findOne.mockResolvedValue(makeConfig({ phMin: 6.5, phMax: 8.5 }));

      await processor.processReading(makeJob());

      expect(gateway.emitAlert).toHaveBeenCalledTimes(1);
      expect(gateway.emitAlert).toHaveBeenCalledWith('proj-1', {
        projectId: 'proj-1',
        deviceId: 'device-uuid-1',
        parameter: 'ph',
        value: 9.2,
        threshold: 8.5,
        direction: 'above',
      });
    });

    it('emits sensor:alert when dissolved oxygen falls below governance doThreshold', async () => {
      readingRepo.findOne.mockResolvedValue(makeReading({ dissolvedOxygen: 4.0 }));
      configRepo.findOne.mockResolvedValue(makeConfig({ doThreshold: 5.0 }));

      await processor.processReading(makeJob());

      expect(gateway.emitAlert).toHaveBeenCalledTimes(1);
      expect(gateway.emitAlert).toHaveBeenCalledWith('proj-1', {
        projectId: 'proj-1',
        deviceId: 'device-uuid-1',
        parameter: 'dissolvedOxygen',
        value: 4.0,
        threshold: 5.0,
        direction: 'below',
      });
    });

    it('emits one alert per breached parameter', async () => {
      readingRepo.findOne.mockResolvedValue(
        makeReading({ ph: 5.5, dissolvedOxygen: 3.0, temperature: 105 }),
      );
      configRepo.findOne.mockResolvedValue(
        makeConfig({ phMin: 6.5, phMax: 8.5, doThreshold: 5.0 }),
      );

      await processor.processReading(makeJob());

      expect(gateway.emitAlert).toHaveBeenCalledTimes(3);
      const parameters = gateway.emitAlert.mock.calls.map(([, alert]) => alert.parameter);
      expect(parameters).toEqual(expect.arrayContaining(['ph', 'dissolvedOxygen', 'temperature']));
    });

    it('falls back to hardcoded thresholds when no governance config row exists', async () => {
      readingRepo.findOne.mockResolvedValue(makeReading({ ph: 5.0 }));
      configRepo.findOne.mockResolvedValue(null);

      await processor.processReading(makeJob());

      // Fallback phMin = 6.0 (mirrors migration-006 back-fill).
      expect(gateway.emitAlert).toHaveBeenCalledWith('proj-1', {
        projectId: 'proj-1',
        deviceId: 'device-uuid-1',
        parameter: 'ph',
        value: 5.0,
        threshold: 6.0,
        direction: 'below',
      });
    });

    it('still emits alerts when the config repo read fails', async () => {
      readingRepo.findOne.mockResolvedValue(makeReading({ ph: 5.0 }));
      configRepo.findOne.mockRejectedValue(new Error('db down'));

      await expect(processor.processReading(makeJob())).resolves.toBeUndefined();

      expect(gateway.emitReading).toHaveBeenCalledTimes(1);
      expect(gateway.emitAlert).toHaveBeenCalledWith(
        'proj-1',
        expect.objectContaining({ parameter: 'ph', threshold: 6.0, direction: 'below' }),
      );
    });
  });

  describe('idempotency (Bull retries)', () => {
    it('does not re-emit events when wsEmittedAt is already set', async () => {
      readingRepo.findOne.mockResolvedValue(
        makeReading({ wsEmittedAt: new Date('2026-01-01T00:00:05.000Z') }),
      );
      configRepo.findOne.mockResolvedValue(makeConfig({ phMin: 6.5, phMax: 8.5 }));
      // Reading is out of range, but the retry must NOT emit anything.
      readingRepo.findOne.mockImplementation(async () =>
        makeReading({
          ph: 5.5,
          wsEmittedAt: new Date('2026-01-01T00:00:05.000Z'),
        }),
      );

      await processor.processReading(makeJob());

      expect(gateway.emitReading).not.toHaveBeenCalled();
      expect(gateway.emitAlert).not.toHaveBeenCalled();
      expect(readingRepo.save).not.toHaveBeenCalled();
    });

    it('re-runs cleanly after a first successful run (same reading, wsEmittedAt set)', async () => {
      const emittedAt = new Date('2026-01-01T00:00:05.000Z');
      readingRepo.findOne.mockResolvedValue(makeReading({ wsEmittedAt: emittedAt }));

      await processor.processReading(makeJob());

      expect(gateway.emitReading).not.toHaveBeenCalled();
      expect(gateway.emitAlert).not.toHaveBeenCalled();
    });
  });

  describe('missing reading', () => {
    it('skips gracefully when the reading row does not exist', async () => {
      readingRepo.findOne.mockResolvedValue(null);

      await expect(processor.processReading(makeJob())).resolves.toBeUndefined();

      expect(gateway.emitReading).not.toHaveBeenCalled();
      expect(gateway.emitAlert).not.toHaveBeenCalled();
      expect(readingRepo.save).not.toHaveBeenCalled();
    });
  });
});
