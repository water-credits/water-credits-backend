import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { InjectQueue } from '@nestjs/bull';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bull';
import { DataSource, Repository, QueryFailedError } from 'typeorm';
import { Keypair } from '@stellar/stellar-sdk';
import { SensorDevice } from './entities/sensor-device.entity';
import { SensorReading } from './entities/sensor-reading.entity';
import { ReadingBatch, BatchStatus, BATCH_WINDOW_MS } from './entities/reading-batch.entity';
import { CreateReadingDto } from './dto/create-reading.dto';
import { QueryReadingsDto } from './dto/query-readings.dto';
import { RegisterDeviceDto } from './dto/register-device.dto';
import { generateDeviceApiKey } from '../../common/utils/api-key.util';
import { SensorProjectAccessService } from './sensor-project-access.service';

interface ParameterRange {
  min: number;
  max: number;
}

const PARAMETER_RANGES: Record<string, ParameterRange> = {
  ph: { min: 0, max: 14 },
  turbidity: { min: 0, max: Infinity },
  dissolvedOxygen: { min: 0, max: Infinity },
  flowRate: { min: 0, max: Infinity },
  nitrogen: { min: 0, max: Infinity },
  phosphorus: { min: 0, max: Infinity },
  temperature: { min: -50, max: 100 },
};

function buildReadingPayload(
  deviceId: string,
  timestamp: string,
  params: Record<string, number | undefined | null>,
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

@Injectable()
export class SensorsService {
  private readonly logger = new Logger(SensorsService.name);

  constructor(
    @InjectRepository(SensorDevice)
    private readonly deviceRepo: Repository<SensorDevice>,
    @InjectRepository(SensorReading)
    private readonly readingRepo: Repository<SensorReading>,
    @InjectRepository(ReadingBatch)
    private readonly batchRepo: Repository<ReadingBatch>,
    @InjectQueue('sensor-ingestion')
    private readonly sensorIngestionQueue: Queue,
    private readonly dataSource: DataSource,
    private readonly projectAccess: SensorProjectAccessService,
    private readonly configService: ConfigService,
  ) {}

  async registerDevice(
    projectId: string,
    dto: RegisterDeviceDto,
    userId: string,
    role?: string,
  ): Promise<SensorDevice & { apiKeyPlaintext: string }> {
    // Verify the caller owns the project (or holds a privileged role)
    await this.projectAccess.assertProjectAccess(userId, role, projectId);

    const existing = await this.deviceRepo.findOne({ where: { deviceId: dto.deviceId } });
    if (existing) {
      throw new BadRequestException('Device with this deviceId already registered');
    }

    const { plaintext, hash } = await generateDeviceApiKey(dto.deviceId);

    // Build parameter map from enum array
    const paramMap: Record<string, boolean> = {};
    for (const p of dto.parameters) {
      paramMap[p] = true;
    }

    const device = this.deviceRepo.create({
      projectId,
      deviceId: dto.deviceId,
      manufacturer: dto.manufacturer,
      model: dto.model,
      publicKey: dto.publicKey,
      parameters: { ...paramMap, ...(dto.metadata ?? {}) },
      apiKeyHash: hash,
      isActive: true,
    });
    const saved = await this.deviceRepo.save(device);

    // Return the plaintext key once — it is never retrievable again
    return Object.assign(saved, { apiKeyPlaintext: plaintext });
  }

  async getDevices(
    projectId: string | undefined,
    userId: string,
    role: string | undefined,
  ): Promise<SensorDevice[]> {
    if (projectId) {
      await this.projectAccess.assertProjectAccess(userId, role, projectId);
      return this.deviceRepo.find({ where: { projectId } });
    }
    this.projectAccess.requirePrivilegedRole(role);
    return this.deviceRepo.find({ order: { createdAt: 'DESC' } });
  }

  async getDeviceById(
    deviceId: string,
    userId: string,
    role: string | undefined,
  ): Promise<SensorDevice> {
    const device = await this.deviceRepo.findOne({ where: { id: deviceId } });
    if (!device) {
      throw new NotFoundException('Sensor device not found');
    }
    await this.projectAccess.assertProjectAccess(userId, role, device.projectId);
    return device;
  }

  async getDeviceByDeviceId(deviceId: string): Promise<SensorDevice> {
    const device = await this.deviceRepo.findOne({ where: { deviceId } });
    if (!device) {
      throw new NotFoundException('Sensor device not found');
    }
    return device;
  }

  async ingestReading(dto: CreateReadingDto): Promise<SensorReading> {
    const device = await this.getDeviceByDeviceId(dto.deviceId);

    const readingTimestamp = new Date(dto.timestamp);
    this.validateTimestamp(readingTimestamp);

    const params: Record<string, number | undefined | null> = {
      ph: dto.ph ?? null,
      turbidity: dto.turbidity ?? null,
      dissolvedOxygen: dto.dissolvedOxygen ?? null,
      flowRate: dto.flowRate ?? null,
      nitrogen: dto.nitrogen ?? null,
      phosphorus: dto.phosphorus ?? null,
      temperature: dto.temperature ?? null,
    };

    this.validateParameters(params);

    const payload = buildReadingPayload(dto.deviceId, dto.timestamp, params);
    const isValid = this.verifySignature(payload, dto.signature, device.publicKey);
    if (!isValid) {
      throw new BadRequestException('Invalid reading signature');
    }

    const batch = await this.resolveBatch(device.projectId);

    // Wrap reading insertion and batch count increment in a transaction
    // to ensure transactional consistency. If the reading insertion fails
    // due to replay protection (unique constraint), we return the existing
    // reading as idempotency ensures the caller gets the same result.
    let saved: SensorReading;
    try {
      saved = await this.dataSource.transaction(async (entityManager) => {
        const reading = this.readingRepo.create({
          deviceId: device.id,
          projectId: device.projectId,
          timestamp: readingTimestamp,
          ph: dto.ph ?? null,
          turbidity: dto.turbidity ?? null,
          dissolvedOxygen: dto.dissolvedOxygen ?? null,
          flowRate: dto.flowRate ?? null,
          nitrogen: dto.nitrogen ?? null,
          phosphorus: dto.phosphorus ?? null,
          temperature: dto.temperature ?? null,
          signature: dto.signature,
          isVerified: true,
          batchId: batch.id,
        });
        const saved = await entityManager.save(reading);
        // Increment batch count atomically
        await entityManager.increment(ReadingBatch, { id: batch.id }, 'readingCount', 1);
        return saved;
      });
    } catch (error) {
      // Handle duplicate reading (replay protection)
      if (error instanceof QueryFailedError && error.databaseError?.code === '23505') {
        // Unique constraint violation - reading already exists
        // Return the existing reading for idempotency
        const existing = await this.readingRepo.findOne({
          where: {
            deviceId: device.id,
            timestamp: readingTimestamp,
            signature: dto.signature,
          },
        });
        if (existing) {
          this.logger.warn(
            `Duplicate reading rejected for device ${device.id} at ${readingTimestamp.toISOString()}. Returning existing reading for idempotency.`,
          );
          return existing;
        }
        throw new BadRequestException('Duplicate reading detected (replay protection)');
      }
      throw error;
    }

    await this.deviceRepo.update(device.id, { lastReadingAt: new Date() });

    // Fan the reading out asynchronously: SensorsIngestionProcessor loads the
    // saved reading, broadcasts it via SensorsGateway (sensor:reading) and
    // evaluates threshold-breach alerts (sensor:alert).  The job is added
    // WITHOUT a name so it lands on Bull's default ('__default__') queue,
    // which is what the unnamed @Process({ concurrency: 5 }) handler in
    // SensorsIngestionProcessor subscribes to.  Default job options (5
    // attempts, exponential backoff) come from the queue registration in
    // SensorsModule.
    await this.sensorIngestionQueue.add({
      readingId: saved.id,
      deviceId: device.id,
      projectId: device.projectId,
    });

    return saved;
  }

  private validateTimestamp(timestamp: Date): void {
    const now = new Date();
    const maxAgeSeconds = this.configService.get<number>('sensor.maxAgeSeconds') || 24 * 60 * 60;
    const futureOffsetSeconds =
      this.configService.get<number>('sensor.futureOffsetSeconds') || 5 * 60;

    const maxAge = new Date(now.getTime() - maxAgeSeconds * 1000);
    const maxFuture = new Date(now.getTime() + futureOffsetSeconds * 1000);

    if (timestamp < maxAge) {
      throw new BadRequestException(
        `Reading timestamp is too old. Maximum age: ${maxAgeSeconds} seconds.`,
      );
    }

    if (timestamp > maxFuture) {
      throw new BadRequestException(
        `Reading timestamp is too far in the future. Maximum offset: ${futureOffsetSeconds} seconds.`,
      );
    }
  }

  private validateParameters(params: Record<string, number | undefined | null>): void {
    for (const [key, value] of Object.entries(params)) {
      if (value === null || value === undefined) {
        continue;
      }
      const range = PARAMETER_RANGES[key];
      if (!range) {
        continue;
      }
      if (value < range.min || value > range.max) {
        throw new BadRequestException(
          `Parameter '${key}' value ${value} is out of range [${range.min}, ${range.max}]`,
        );
      }
    }
  }

  private verifySignature(payload: string, signature: string, publicKey: string): boolean {
    try {
      const keypair = Keypair.fromPublicKey(publicKey);
      return keypair.verify(Buffer.from(payload, 'utf-8'), Buffer.from(signature, 'base64'));
    } catch {
      return false;
    }
  }

  /**
   * Return the current open PENDING batch for the given project, creating one
   * if none exists within the active collection window.
   *
   * Race-safety: two concurrent callers for the same project must never produce
   * more than one PENDING row.  We achieve this with a two-phase approach:
   *
   *   1. Attempt an INSERT … ON CONFLICT (project_id) WHERE status = 'pending'
   *      DO NOTHING.  The partial unique index added in migration 012 makes the
   *      conflict target precise.  Exactly one concurrent caller wins the INSERT;
   *      the rest get 0 rows from RETURNING and fall through to the SELECT.
   *
   *   2. SELECT the PENDING batch (either the one just inserted or the one that
   *      already existed).  This second read is guaranteed to find exactly one
   *      row because the unique index prevents duplicates.
   *
   * If the PENDING batch that is already in the table is older than the 15-minute
   * collection window, we close it (set status = 'submitted' so the oracle
   * scheduler picks it up) before inserting a fresh one.  The window-expiry
   * check + status flip is wrapped in a single UPDATE … WHERE to avoid a
   * separate round-trip.
   */
  private async resolveBatch(projectId: string): Promise<ReadingBatch> {
    const cutoff = new Date(Date.now() - BATCH_WINDOW_MS);

    // Close any stale PENDING batch for this project atomically before we try
    // to create a new one.  If none is stale (or none exists at all), 0 rows
    // are updated and we proceed straight to the INSERT attempt.
    await this.dataSource.query<void>(
      `UPDATE reading_batches
          SET status     = $1,
              updated_at = NOW()
        WHERE project_id = $2
          AND status     = $3
          AND created_at < $4`,
      [BatchStatus.SUBMITTED, projectId, BatchStatus.PENDING, cutoff],
    );

    // Attempt to insert a fresh PENDING batch.  The partial unique index on
    // (project_id) WHERE status = 'pending' turns a concurrent duplicate INSERT
    // into a no-op (DO NOTHING), so only one row is ever created.
    await this.dataSource.query<void>(
      `INSERT INTO reading_batches (project_id, status, reading_count)
       VALUES ($1, $2, 0)
       ON CONFLICT (project_id) WHERE status = 'pending'
       DO NOTHING`,
      [projectId, BatchStatus.PENDING],
    );

    // At this point exactly one PENDING batch exists for this project.
    // Map the raw row back through the entity so callers receive a typed object.
    const rows = await this.dataSource.query<
      {
        id: string;
        project_id: string;
        status: string;
        reading_count: number;
        created_at: Date;
        updated_at: Date;
      }[]
    >(
      `SELECT id, project_id, status, reading_count, created_at, updated_at
         FROM reading_batches
        WHERE project_id = $1
          AND status     = $2
        LIMIT 1`,
      [projectId, BatchStatus.PENDING],
    );

    // Map snake_case columns back to the entity shape expected by callers.
    const row = rows[0];
    const batch = this.batchRepo.create({
      id: row.id,
      projectId: row.project_id,
      status: row.status as BatchStatus,
      readingCount: row.reading_count,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
    return batch;
  }

  async getReadings(
    query: QueryReadingsDto,
    userId: string,
    role: string | undefined,
  ): Promise<{
    data: SensorReading[];
    total: number;
    page: number;
    limit: number;
  }> {
    const qb = this.readingRepo.createQueryBuilder('reading');

    if (query.projectId) {
      await this.projectAccess.assertProjectAccess(userId, role, query.projectId);
    } else if (query.deviceId) {
      const device = await this.getDeviceByDeviceId(query.deviceId);
      await this.projectAccess.assertProjectAccess(userId, role, device.projectId);
    } else {
      this.projectAccess.requirePrivilegedRole(role);
    }

    if (query.deviceId) {
      qb.andWhere('reading.device_id = :deviceId', { deviceId: query.deviceId });
    }
    if (query.projectId) {
      qb.andWhere('reading.project_id = :projectId', { projectId: query.projectId });
    }
    if (query.startDate) {
      qb.andWhere('reading.timestamp >= :startDate', { startDate: query.startDate });
    }
    if (query.endDate) {
      qb.andWhere('reading.timestamp <= :endDate', { endDate: query.endDate });
    }

    qb.orderBy('reading.timestamp', 'DESC');
    qb.skip(query.skip).take(query.limit);

    const [data, total] = await qb.getManyAndCount();
    return { data, total, page: query.page ?? 1, limit: query.limit ?? 20 };
  }

  /**
   * Return the latest reading for a specific device (when `deviceId` is
   * provided) or the latest reading per device across the whole fleet (when
   * `deviceId` is omitted).
   *
   * The no-deviceId path previously issued one `findOne` per device (N+1).
   * It is now a single `DISTINCT ON (device_id)` query — PostgreSQL resolves
   * it with one index scan on (device_id, timestamp DESC) and returns exactly
   * one row per device regardless of fleet size.
   */
  async getLatestReading(
    userId: string,
    role: string | undefined,
    deviceId?: string,
  ): Promise<SensorReading | SensorReading[]> {
    if (deviceId) {
      const device = await this.getDeviceByDeviceId(deviceId);
      await this.projectAccess.assertProjectAccess(userId, role, device.projectId);
      const reading = await this.readingRepo.findOne({
        where: { deviceId: device.id },
        order: { timestamp: 'DESC' },
      });
      if (!reading) {
        throw new NotFoundException('No readings found for this device');
      }
      return reading;
    }

    this.projectAccess.requirePrivilegedRole(role);

    // Single-query path: DISTINCT ON picks the row with the greatest timestamp
    // for each device_id.  TypeORM's QueryBuilder has no native DISTINCT ON
    // support (it is PostgreSQL-specific), so we use a typed raw query and
    // map the snake_case result back to SensorReading instances.
    const rows = await this.dataSource.query<
      {
        id: string;
        device_id: string;
        project_id: string;
        timestamp: Date;
        ph: string | null;
        turbidity: string | null;
        dissolved_oxygen: string | null;
        flow_rate: string | null;
        nitrogen: string | null;
        phosphorus: string | null;
        temperature: string | null;
        signature: string;
        is_verified: boolean;
        batch_id: string | null;
        created_at: Date;
      }[]
    >(
      `SELECT DISTINCT ON (device_id)
              id,
              device_id,
              project_id,
              timestamp,
              ph,
              turbidity,
              dissolved_oxygen,
              flow_rate,
              nitrogen,
              phosphorus,
              temperature,
              signature,
              is_verified,
              batch_id,
              created_at
         FROM sensor_readings
        ORDER BY device_id, timestamp DESC`,
    );

    return rows.map((row) =>
      this.readingRepo.create({
        id: row.id,
        deviceId: row.device_id,
        projectId: row.project_id,
        timestamp: row.timestamp,
        ph: row.ph !== null ? parseFloat(row.ph) : null,
        turbidity: row.turbidity !== null ? parseFloat(row.turbidity) : null,
        dissolvedOxygen: row.dissolved_oxygen !== null ? parseFloat(row.dissolved_oxygen) : null,
        flowRate: row.flow_rate !== null ? parseFloat(row.flow_rate) : null,
        nitrogen: row.nitrogen !== null ? parseFloat(row.nitrogen) : null,
        phosphorus: row.phosphorus !== null ? parseFloat(row.phosphorus) : null,
        temperature: row.temperature !== null ? parseFloat(row.temperature) : null,
        signature: row.signature,
        isVerified: row.is_verified,
        batchId: row.batch_id,
        createdAt: row.created_at,
      }),
    );
  }

  async getAggregatedSummary(
    projectId: string,
    startDate?: string,
    endDate?: string,
  ): Promise<Record<string, number | null>> {
    const qb = this.readingRepo
      .createQueryBuilder('reading')
      .select('AVG(reading.ph)', 'avgPh')
      .addSelect('AVG(reading.turbidity)', 'avgTurbidity')
      .addSelect('AVG(reading.dissolved_oxygen)', 'avgDissolvedOxygen')
      .addSelect('AVG(reading.flow_rate)', 'avgFlowRate')
      .addSelect('AVG(reading.nitrogen)', 'avgNitrogen')
      .addSelect('AVG(reading.phosphorus)', 'avgPhosphorus')
      .addSelect('AVG(reading.temperature)', 'avgTemperature')
      .addSelect('COUNT(reading.id)', 'totalReadings')
      .where('reading.project_id = :projectId', { projectId });

    if (startDate) {
      qb.andWhere('reading.timestamp >= :startDate', { startDate });
    }
    if (endDate) {
      qb.andWhere('reading.timestamp <= :endDate', { endDate });
    }

    const result = await qb.getRawOne();
    return {
      avgPh: result?.avgPh ? parseFloat(result.avgPh) : null,
      avgTurbidity: result?.avgTurbidity ? parseFloat(result.avgTurbidity) : null,
      avgDissolvedOxygen: result?.avgDissolvedOxygen ? parseFloat(result.avgDissolvedOxygen) : null,
      avgFlowRate: result?.avgFlowRate ? parseFloat(result.avgFlowRate) : null,
      avgNitrogen: result?.avgNitrogen ? parseFloat(result.avgNitrogen) : null,
      avgPhosphorus: result?.avgPhosphorus ? parseFloat(result.avgPhosphorus) : null,
      avgTemperature: result?.avgTemperature ? parseFloat(result.avgTemperature) : null,
      totalReadings: result?.totalReadings ? parseInt(result.totalReadings, 10) : 0,
    };
  }
}
