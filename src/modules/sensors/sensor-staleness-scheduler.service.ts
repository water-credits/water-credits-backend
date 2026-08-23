import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, LessThan, Repository } from 'typeorm';
import { SensorDevice } from './entities/sensor-device.entity';
import { SensorsGateway } from './sensors.gateway';
import { SensorAlertDebounceService } from './sensor-alert-debounce.service';
import { SensorAlertRecipientsService } from './sensor-alert-recipients.service';
import { NotificationsService } from '../notifications/notifications.service';
import {
  DEFAULT_SENSOR_ALERT_DEBOUNCE_MS,
  DEFAULT_SENSOR_STALE_AFTER_MINUTES,
} from '../../config/sensor.config';

export interface StalenessCheckResult {
  /** Active devices with a lastReadingAt older than the staleness cutoff (or never reported). */
  staleDevices: number;
  /** Of those, how many actually got a fresh alert (the rest were debounced). */
  alertsSent: number;
  skipped: boolean;
}

/**
 * Periodically scans for devices that have gone quiet — no reading for
 * longer than `sensor.staleAfterMinutes` — and raises the same `sensor:alert`
 * / persisted-notification pipeline threshold breaches use.
 *
 * Threshold breaches are caught inline as readings arrive
 * (`SensorsIngestionProcessor`); staleness is the opposite failure mode — the
 * absence of a reading — so it can only be detected by polling. Debounced
 * through the same `SensorAlertDebounceService` so a device stuck offline
 * for days doesn't re-notify every tick.
 */
@Injectable()
export class SensorStalenessSchedulerService {
  private readonly logger = new Logger(SensorStalenessSchedulerService.name);
  private running = false;

  constructor(
    @InjectRepository(SensorDevice)
    private readonly deviceRepo: Repository<SensorDevice>,
    private readonly gateway: SensorsGateway,
    private readonly debounce: SensorAlertDebounceService,
    private readonly recipients: SensorAlertRecipientsService,
    private readonly notifications: NotificationsService,
    private readonly configService: ConfigService,
  ) {}

  @Cron(CronExpression.EVERY_5_MINUTES, { name: 'sensor-staleness-check' })
  async handleCron(): Promise<StalenessCheckResult> {
    return this.runStalenessCheck();
  }

  async runStalenessCheck(): Promise<StalenessCheckResult> {
    const empty: StalenessCheckResult = { staleDevices: 0, alertsSent: 0, skipped: true };

    if (this.running) {
      this.logger.warn('Previous staleness check still running, skipping this tick');
      return empty;
    }

    this.running = true;
    try {
      const staleAfterMinutes = this.configService.get<number>(
        'sensor.staleAfterMinutes',
        DEFAULT_SENSOR_STALE_AFTER_MINUTES,
      );
      const debounceMs = this.configService.get<number>(
        'sensor.alertDebounceMs',
        DEFAULT_SENSOR_ALERT_DEBOUNCE_MS,
      );
      const cutoff = new Date(Date.now() - staleAfterMinutes * 60 * 1000);

      // A device that has never reported (lastReadingAt IS NULL) is also
      // stale once it's old enough to plausibly have reported by now.
      const staleDevices = await this.deviceRepo.find({
        where: [
          { isActive: true, lastReadingAt: LessThan(cutoff) },
          { isActive: true, lastReadingAt: IsNull(), createdAt: LessThan(cutoff) },
        ],
      });

      let alertsSent = 0;
      for (const device of staleDevices) {
        const sent = await this.alertOnStaleDevice(device, staleAfterMinutes, debounceMs);
        if (sent) {
          alertsSent += 1;
        }
      }

      if (staleDevices.length > 0) {
        this.logger.log(
          `Staleness check: ${staleDevices.length} stale device(s), ${alertsSent} alert(s) sent (rest debounced)`,
        );
      }

      return { staleDevices: staleDevices.length, alertsSent, skipped: false };
    } catch (err) {
      this.logger.error(`Staleness check failed: ${(err as Error).message}`);
      return empty;
    } finally {
      this.running = false;
    }
  }

  private async alertOnStaleDevice(
    device: SensorDevice,
    staleAfterMinutes: number,
    debounceMs: number,
  ): Promise<boolean> {
    const debounceKey = `${device.id}:staleness`;

    try {
      if (await this.debounce.shouldSuppress(debounceKey, debounceMs)) {
        return false;
      }
    } catch (err) {
      this.logger.warn(
        `Staleness debounce check failed for device ${device.id}, proceeding without it: ${(err as Error).message}`,
      );
    }

    const staleMinutes = device.lastReadingAt
      ? Math.floor((Date.now() - device.lastReadingAt.getTime()) / 60000)
      : null;

    const alert = {
      projectId: device.projectId,
      deviceId: device.deviceId,
      parameter: 'staleness',
      staleMinutes: staleMinutes ?? staleAfterMinutes,
      thresholdMinutes: staleAfterMinutes,
    };

    this.logger.warn(
      `Device ${device.deviceId} (project ${device.projectId}) has been silent for ${
        staleMinutes ?? 'more than'
      } minute(s)`,
    );
    this.gateway.emitAlert(device.projectId, alert);

    try {
      const userIds = await this.recipients.resolveRecipients(device.projectId);
      await Promise.all(
        userIds.map((userId) =>
          this.notifications.notifySensorAlert(userId, device.projectId, alert),
        ),
      );
    } catch (err) {
      this.logger.error(
        `Failed to persist staleness notifications for device ${device.id}: ${(err as Error).message}`,
      );
    }

    return true;
  }
}
