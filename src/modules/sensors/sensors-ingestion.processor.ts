import { Process, Processor } from '@nestjs/bull';
import { Job } from 'bull';
import { Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import { SensorReading } from './entities/sensor-reading.entity';
import { GovernanceConfig } from '../governance/entities/governance-config.entity';
import { SensorsGateway } from './sensors.gateway';
import { SensorAlertDebounceService } from './sensor-alert-debounce.service';
import { SensorAlertRecipientsService } from './sensor-alert-recipients.service';
import { NotificationsService } from '../notifications/notifications.service';
import { DEFAULT_SENSOR_ALERT_DEBOUNCE_MS } from '../../config/sensor.config';

export interface SensorIngestionJobData {
  readingId: string;
  deviceId: string;
  projectId: string;
}

interface ParameterThresholds {
  min?: number;
  max?: number;
}

/**
 * Fallback alert thresholds used when no GovernanceConfig row exists yet.
 *
 * - pH bounds and the dissolved-oxygen threshold mirror the values back-filled
 *   into governance_config by migration 006 (ph_min 6.0, ph_max 9.0,
 *   do_threshold 5.0) so alerts are consistent with oracle scoring.
 * - The remaining parameters fall back to physical plausibility ranges.
 */
const DEFAULT_THRESHOLDS: Record<string, ParameterThresholds> = {
  ph: { min: 6.0, max: 9.0 },
  turbidity: { min: 0 },
  dissolvedOxygen: { min: 5.0 },
  flowRate: { min: 0 },
  nitrogen: { min: 0 },
  phosphorus: { min: 0 },
  temperature: { min: -50, max: 100 },
};

/** Numeric reading columns that participate in threshold-breach alerting. */
const ALERT_PARAMETERS: Array<
  keyof Pick<
    SensorReading,
    'ph' | 'turbidity' | 'dissolvedOxygen' | 'flowRate' | 'nitrogen' | 'phosphorus' | 'temperature'
  >
> = ['ph', 'turbidity', 'dissolvedOxygen', 'flowRate', 'nitrogen', 'phosphorus', 'temperature'];

/**
 * Async worker for the `sensor-ingestion` Bull queue.
 *
 * For each saved reading it:
 *   1. loads the persisted SensorReading by id,
 *   2. broadcasts it to the project room via SensorsGateway.emitReading()
 *      (`sensor:reading`),
 *   3. evaluates every numeric parameter against governance-controlled
 *      thresholds and emits SensorsGateway.emitAlert() (`sensor:alert`) for
 *      each breach,
 *   4. stamps `wsEmittedAt` so a Bull retry (default 5 attempts, exponential
 *      backoff) never re-emits events for a reading that was already fanned
 *      out — idempotent by construction.
 */
@Processor('sensor-ingestion')
export class SensorsIngestionProcessor {
  private readonly logger = new Logger(SensorsIngestionProcessor.name);

  constructor(
    @InjectRepository(SensorReading)
    private readonly readingRepo: Repository<SensorReading>,
    @InjectRepository(GovernanceConfig)
    private readonly configRepo: Repository<GovernanceConfig>,
    private readonly gateway: SensorsGateway,
    private readonly debounce: SensorAlertDebounceService,
    private readonly recipients: SensorAlertRecipientsService,
    private readonly notifications: NotificationsService,
    private readonly configService: ConfigService,
  ) {}

  @Process({
    concurrency: 5,
  })
  async processReading(job: Job<SensorIngestionJobData>): Promise<void> {
    const { readingId, deviceId, projectId } = job.data;

    this.logger.debug(`Processing reading ${readingId} from device ${deviceId}`);

    const reading = await this.readingRepo.findOne({ where: { id: readingId } });

    if (!reading) {
      // Nothing to fan out — a job for a deleted/unknown reading is a no-op.
      this.logger.warn(`Reading ${readingId} not found, skipping`);
      return;
    }

    // Idempotency guard: if a previous attempt already emitted the WebSocket
    // events for this reading, a retry must not re-emit them.
    if (reading.wsEmittedAt) {
      this.logger.debug(
        `Reading ${readingId} already emitted at ${reading.wsEmittedAt.toISOString()}, skipping`,
      );
      return;
    }

    const thresholds = await this.resolveThresholds();

    // 1. Fan the raw reading out to the project's WebSocket room.
    this.gateway.emitReading(projectId, this.buildReadingPayload(reading));

    // 2. Evaluate each numeric parameter against its threshold(s) and emit
    //    `sensor:alert` for every out-of-range value.
    for (const parameter of ALERT_PARAMETERS) {
      const rawValue = reading[parameter];
      if (rawValue === null || rawValue === undefined) {
        continue;
      }
      // TypeORM maps `decimal` columns to strings, so coerce defensively.
      const value = Number(rawValue);
      if (Number.isNaN(value)) {
        continue;
      }

      const range = thresholds[parameter];
      if (!range) {
        continue;
      }

      if (range.min !== undefined && value < range.min) {
        await this.emitAlert(reading, parameter, value, range.min, 'below');
      } else if (range.max !== undefined && value > range.max) {
        await this.emitAlert(reading, parameter, value, range.max, 'above');
      }
    }

    // 3. Stamp the idempotency flag and persist it.  Once saved, any Bull
    //    retry of this job sees wsEmittedAt set and skips — no double-emit.
    reading.wsEmittedAt = new Date();
    await this.readingRepo.save(reading);
  }

  /**
   * Resolve alert thresholds, preferring governance-controlled values
   * (phMin / phMax / doThreshold from GovernanceConfig) and falling back to
   * the hardcoded defaults when the row is absent.
   */
  private async resolveThresholds(): Promise<Record<string, ParameterThresholds>> {
    let config: GovernanceConfig | null = null;
    try {
      config = await this.configRepo.findOne({ where: {} as Record<string, never> });
    } catch (err) {
      this.logger.warn(
        `Failed to load GovernanceConfig for alert thresholds: ${(err as Error).message}`,
      );
    }

    return {
      ...DEFAULT_THRESHOLDS,
      ph: {
        min: this.coerce(config?.phMin, DEFAULT_THRESHOLDS.ph.min),
        max: this.coerce(config?.phMax, DEFAULT_THRESHOLDS.ph.max),
      },
      dissolvedOxygen: {
        min: this.coerce(config?.doThreshold, DEFAULT_THRESHOLDS.dissolvedOxygen.min),
      },
    };
  }

  private coerce(
    value: number | string | null | undefined,
    fallback: number | undefined,
  ): number | undefined {
    if (value === null || value === undefined) {
      return fallback;
    }
    const num = Number(value);
    return Number.isNaN(num) ? fallback : num;
  }

  private buildReadingPayload(reading: SensorReading): Record<string, unknown> {
    return {
      id: reading.id,
      deviceId: reading.deviceId,
      projectId: reading.projectId,
      timestamp: reading.timestamp,
      ph: reading.ph,
      turbidity: reading.turbidity,
      dissolvedOxygen: reading.dissolvedOxygen,
      flowRate: reading.flowRate,
      nitrogen: reading.nitrogen,
      phosphorus: reading.phosphorus,
      temperature: reading.temperature,
      isVerified: reading.isVerified,
      batchId: reading.batchId,
      createdAt: reading.createdAt,
    };
  }

  private async emitAlert(
    reading: SensorReading,
    parameter: string,
    value: number,
    threshold: number,
    direction: 'below' | 'above',
  ): Promise<void> {
    this.logger.warn(
      `Threshold breach on reading ${reading.id}: ${parameter}=${value} is ${direction} threshold ${threshold}`,
    );
    const alert = {
      projectId: reading.projectId,
      deviceId: reading.deviceId,
      parameter,
      value,
      threshold,
      direction,
    };

    // WS fan-out is not debounced — live viewers should always see the raw
    // breach. Only the persisted notification (which fans out to every
    // owner/verifier) is subject to the debounce, since that's what would
    // actually flood people's inboxes.
    this.gateway.emitAlert(reading.projectId, alert);
    await this.notifyRecipients(reading.deviceId, reading.projectId, parameter, direction, alert);
  }

  /** Debounced fan-out of a persisted notification to project owners/verifiers. */
  private async notifyRecipients(
    deviceId: string,
    projectId: string,
    parameter: string,
    direction: string,
    alert: Record<string, unknown>,
  ): Promise<void> {
    const debounceMs =
      this.configService.get<number>('sensor.alertDebounceMs') ?? DEFAULT_SENSOR_ALERT_DEBOUNCE_MS;
    const debounceKey = `${deviceId}:${parameter}:${direction}`;

    try {
      if (await this.debounce.shouldSuppress(debounceKey, debounceMs)) {
        this.logger.debug(`Suppressing duplicate alert notification for ${debounceKey}`);
        return;
      }
    } catch (err) {
      // Debounce is a courtesy, not a correctness guarantee — if the storage
      // backend is unavailable we'd rather over-notify than silently drop
      // an anomaly.
      this.logger.warn(
        `Alert debounce check failed for ${debounceKey}, proceeding without it: ${(err as Error).message}`,
      );
    }

    try {
      const userIds = await this.recipients.resolveRecipients(projectId);
      await Promise.all(
        userIds.map((userId) => this.notifications.notifySensorAlert(userId, projectId, alert)),
      );
    } catch (err) {
      this.logger.error(
        `Failed to persist notifications for alert ${debounceKey}: ${(err as Error).message}`,
      );
    }
  }
}
