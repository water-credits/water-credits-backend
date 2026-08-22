import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { SensorStalenessSchedulerService } from './sensor-staleness-scheduler.service';
import { SensorDevice } from './entities/sensor-device.entity';
import { SensorsGateway } from './sensors.gateway';
import { SensorAlertDebounceService } from './sensor-alert-debounce.service';
import { SensorAlertRecipientsService } from './sensor-alert-recipients.service';
import { NotificationsService } from '../notifications/notifications.service';

function makeDevice(overrides: Partial<SensorDevice> = {}): SensorDevice {
  return {
    id: 'device-uuid-1',
    projectId: 'proj-1',
    deviceId: 'ext-device-1',
    manufacturer: 'Acme',
    model: 'X1',
    parameters: null,
    publicKey: 'pub',
    apiKeyHash: null,
    isActive: true,
    lastReadingAt: new Date('2026-01-01T00:00:00.000Z'),
    createdAt: new Date('2025-12-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  } as SensorDevice;
}

describe('SensorStalenessSchedulerService', () => {
  let service: SensorStalenessSchedulerService;

  let deviceRepo: { find: jest.Mock };
  let gateway: { emitAlert: jest.Mock };
  let debounce: { shouldSuppress: jest.Mock };
  let recipients: { resolveRecipients: jest.Mock };
  let notifications: { notifySensorAlert: jest.Mock };
  let configService: { get: jest.Mock };

  beforeEach(async () => {
    deviceRepo = { find: jest.fn() };
    gateway = { emitAlert: jest.fn() };
    debounce = { shouldSuppress: jest.fn().mockResolvedValue(false) };
    recipients = { resolveRecipients: jest.fn().mockResolvedValue(['owner-1', 'verifier-1']) };
    notifications = { notifySensorAlert: jest.fn().mockResolvedValue(undefined) };
    configService = {
      get: jest.fn((key: string, fallback?: unknown) => fallback),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SensorStalenessSchedulerService,
        { provide: getRepositoryToken(SensorDevice), useValue: deviceRepo },
        { provide: SensorsGateway, useValue: gateway },
        { provide: SensorAlertDebounceService, useValue: debounce },
        { provide: SensorAlertRecipientsService, useValue: recipients },
        { provide: NotificationsService, useValue: notifications },
        { provide: ConfigService, useValue: configService },
      ],
    }).compile();

    service = module.get<SensorStalenessSchedulerService>(SensorStalenessSchedulerService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('does nothing when no devices are stale', async () => {
    deviceRepo.find.mockResolvedValue([]);

    const result = await service.runStalenessCheck();

    expect(result).toEqual({ staleDevices: 0, alertsSent: 0, skipped: false });
    expect(gateway.emitAlert).not.toHaveBeenCalled();
    expect(notifications.notifySensorAlert).not.toHaveBeenCalled();
  });

  it('emits an alert and persists notifications for each stale device', async () => {
    const device = makeDevice();
    deviceRepo.find.mockResolvedValue([device]);

    const result = await service.runStalenessCheck();

    expect(result.staleDevices).toBe(1);
    expect(result.alertsSent).toBe(1);
    expect(gateway.emitAlert).toHaveBeenCalledTimes(1);
    expect(gateway.emitAlert).toHaveBeenCalledWith(
      'proj-1',
      expect.objectContaining({ deviceId: 'ext-device-1', parameter: 'staleness' }),
    );
    expect(recipients.resolveRecipients).toHaveBeenCalledWith('proj-1');
    expect(notifications.notifySensorAlert).toHaveBeenCalledTimes(2);
  });

  it('skips persisted notifications (but still emits WS) when debounced', async () => {
    debounce.shouldSuppress.mockResolvedValue(true);
    deviceRepo.find.mockResolvedValue([makeDevice()]);

    const result = await service.runStalenessCheck();

    expect(result.alertsSent).toBe(0);
    expect(gateway.emitAlert).not.toHaveBeenCalled();
    expect(notifications.notifySensorAlert).not.toHaveBeenCalled();
  });

  it('handles a device that has never reported a reading', async () => {
    deviceRepo.find.mockResolvedValue([makeDevice({ lastReadingAt: null })]);

    const result = await service.runStalenessCheck();

    expect(result.alertsSent).toBe(1);
    expect(gateway.emitAlert).toHaveBeenCalledWith(
      'proj-1',
      expect.objectContaining({ staleMinutes: expect.any(Number) }),
    );
  });

  it('does not let a repository error crash the tick', async () => {
    deviceRepo.find.mockRejectedValue(new Error('db down'));

    const result = await service.runStalenessCheck();

    expect(result).toEqual({ staleDevices: 0, alertsSent: 0, skipped: true });
  });

  it('skips a tick that overlaps a still-running previous check', async () => {
    let resolveFirst!: () => void;
    deviceRepo.find.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveFirst = () => resolve([]);
      }),
    );

    const firstRun = service.runStalenessCheck();
    const secondRun = await service.runStalenessCheck();

    expect(secondRun.skipped).toBe(true);

    resolveFirst();
    await firstRun;
  });
});
