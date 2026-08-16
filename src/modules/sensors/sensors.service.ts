import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Keypair } from '@stellar/stellar-sdk';
import { SensorDevice } from './entities/sensor-device.entity';
import { SensorReading } from './entities/sensor-reading.entity';
import { ReadingBatch, BatchStatus } from './entities/reading-batch.entity';
import { CreateReadingDto } from './dto/create-reading.dto';
import { QueryReadingsDto } from './dto/query-readings.dto';
import { RegisterDeviceDto } from './dto/register-device.dto';
import { TimeSeriesQueryDto, SensorParameter } from './dto/time-series-query.dto';
import { generateDeviceApiKey } from '../../common/utils/api-key.util';

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

const PARAMETER_COLUMN_MAP: Record<SensorParameter, string> = {
  [SensorParameter.PH]: 'ph',
  [SensorParameter.TURBIDITY]: 'turbidity',
  [SensorParameter.DISSOLVED_OXYGEN]: 'dissolved_oxygen',
  [SensorParameter.FLOW_RATE]: 'flow_rate',
  [SensorParameter.NITROGEN]: 'nitrogen',
  [SensorParameter.PHOSPHORUS]: 'phosphorus',
  [SensorParameter.TEMPERATURE]: 'temperature',
};

const MAX_BUCKETS = 1000;

const BATCH_WINDOW_MS = 15 * 60 * 1000;

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
  constructor(
    @InjectRepository(SensorDevice)
    private readonly deviceRepo: Repository<SensorDevice>,
    @InjectRepository(SensorReading)
    private readonly readingRepo: Repository<SensorReading>,
    @InjectRepository(ReadingBatch)
    private readonly batchRepo: Repository<ReadingBatch>,
  ) {}

  async registerDevice(
    projectId: string,
    dto: RegisterDeviceDto,
  ): Promise<SensorDevice & { apiKeyPlaintext: string }> {
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

  async getDevices(projectId?: string): Promise<SensorDevice[]> {
    if (projectId) {
      return this.deviceRepo.find({ where: { projectId } });
    }
    return this.deviceRepo.find({ order: { createdAt: 'DESC' } });
  }

  async getDeviceById(deviceId: string): Promise<SensorDevice> {
    const device = await this.deviceRepo.findOne({ where: { id: deviceId } });
    if (!device) {
      throw new NotFoundException('Sensor device not found');
    }
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

    const reading = this.readingRepo.create({
      deviceId: device.id,
      projectId: device.projectId,
      timestamp: new Date(dto.timestamp),
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

    const saved = await this.readingRepo.save(reading);

    await this.deviceRepo.update(device.id, { lastReadingAt: new Date() });

    await this.batchRepo.increment({ id: batch.id }, 'readingCount', 1);

    return saved;
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

  private async resolveBatch(projectId: string): Promise<ReadingBatch> {
    const cutoff = new Date(Date.now() - BATCH_WINDOW_MS);
    const pending = await this.batchRepo.findOne({
      where: { projectId, status: BatchStatus.PENDING },
      order: { createdAt: 'DESC' },
    });

    if (pending && pending.createdAt >= cutoff) {
      return pending;
    }

    const batch = this.batchRepo.create({
      projectId,
      status: BatchStatus.PENDING,
      readingCount: 0,
    });
    return this.batchRepo.save(batch);
  }

  async getReadings(query: QueryReadingsDto): Promise<{
    data: SensorReading[];
    total: number;
    page: number;
    limit: number;
  }> {
    const qb = this.readingRepo.createQueryBuilder('reading');

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

  async getLatestReading(deviceId?: string): Promise<SensorReading | SensorReading[]> {
    if (deviceId) {
      const device = await this.getDeviceByDeviceId(deviceId);
      const reading = await this.readingRepo.findOne({
        where: { deviceId: device.id },
        order: { timestamp: 'DESC' },
      });
      if (!reading) {
        throw new NotFoundException('No readings found for this device');
      }
      return reading;
    }

    const devices = await this.deviceRepo.find({ order: { createdAt: 'DESC' } });
    const readings: SensorReading[] = [];
    for (const device of devices) {
      const reading = await this.readingRepo.findOne({
        where: { deviceId: device.id },
        order: { timestamp: 'DESC' },
      });
      if (reading) {
        readings.push(reading);
      }
    }
    return readings;
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

  async getTimeSeriesData(
    projectId: string,
    dto: TimeSeriesQueryDto,
  ): Promise<{
    data: Array<{ bucket: string; avg: number; min: number; max: number; count: number }>;
    truncated: boolean;
    total: number;
  }> {
    const column = PARAMETER_COLUMN_MAP[dto.parameter];
    if (!column) {
      throw new BadRequestException(`Invalid parameter: ${dto.parameter}`);
    }

    const qb = this.readingRepo
      .createQueryBuilder('reading')
      .select(`DATE_TRUNC(:bucket, reading.timestamp)`, 'bucket')
      .addSelect(`AVG(reading.${column})`, 'avg')
      .addSelect(`MIN(reading.${column})`, 'min')
      .addSelect(`MAX(reading.${column})`, 'max')
      .addSelect(`COUNT(reading.id)`, 'count')
      .where('reading.project_id = :projectId', { projectId })
      .andWhere('reading.timestamp >= :startDate', { startDate: dto.startDate })
      .andWhere('reading.timestamp <= :endDate', { endDate: dto.endDate })
      .groupBy(`DATE_TRUNC(:bucket, reading.timestamp)`)
      .orderBy('bucket', 'ASC')
      .setParameter('bucket', dto.bucket);

    const results = await qb.getRawMany();

    // Apply row limit for large time ranges
    const truncated = results.length > MAX_BUCKETS;
    const data = truncated ? results.slice(0, MAX_BUCKETS) : results;

    // Format the results
    const formattedData = data.map((row: any) => ({
      bucket: row.bucket,
      avg: row.avg ? parseFloat(row.avg) : 0,
      min: row.min ? parseFloat(row.min) : 0,
      max: row.max ? parseFloat(row.max) : 0,
      count: parseInt(row.count, 10),
    }));

    return {
      data: formattedData,
      truncated,
      total: results.length,
    };
  }
}
