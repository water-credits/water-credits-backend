import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { Repository, DataSource, MoreThan, SelectQueryBuilder } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { OracleSubmission, SubmissionStatus } from './entities/oracle-submission.entity';
import { OracleQueryDto } from './dto/oracle-query.dto';
import { TriggerSubmissionDto } from './dto/trigger-submission.dto';
import { StellarService } from '../stellar/stellar.service';
import { SensorReading } from '../sensors/entities/sensor-reading.entity';
import { paginate, PaginatedList } from '../../common/pagination';

export interface AggregatedReading {
  medianPh: number | null;
  medianTurbidity: number | null;
  medianDissolvedOxygen: number | null;
  medianFlowRate: number | null;
  medianNitrogen: number | null;
  medianPhosphorus: number | null;
  medianTemperature: number | null;
  /**
   * Number of verified sensor readings included in the aggregation.
   */
  oracleCount: number;
  startTime: Date;
  endTime: Date;
}

interface AggregationRow {
  medianPh: string | null;
  medianTurbidity: string | null;
  medianDissolvedOxygen: string | null;
  medianFlowRate: string | null;
  medianNitrogen: string | null;
  medianPhosphorus: string | null;
  medianTemperature: string | null;
  oracleCount: string;
  startTime: Date | null;
  endTime: Date | null;
}

@Injectable()
export class OracleService {
  private readonly logger = new Logger(OracleService.name);

  constructor(
    @InjectRepository(OracleSubmission)
    private readonly submissionRepo: Repository<OracleSubmission>,
    @InjectRepository(SensorReading)
    private readonly readingRepo: Repository<SensorReading>,
    @InjectQueue('oracle-submit')
    private readonly oracleQueue: Queue,
    private readonly configService: ConfigService,
    private readonly dataSource: DataSource,
    private readonly stellarService: StellarService,
  ) {}

  async getStatus(): Promise<{
    totalSubmissions: number;
    pending: number;
    confirmed: number;
    failed: number;
    lastSubmission: OracleSubmission | null;
  }> {
    const [totalSubmissions, pending, confirmed, failed, lastSubmission] = await Promise.all([
      this.submissionRepo.count(),
      this.submissionRepo.count({ where: { status: SubmissionStatus.PENDING } }),
      this.submissionRepo.count({ where: { status: SubmissionStatus.CONFIRMED } }),
      this.submissionRepo.count({ where: { status: SubmissionStatus.FAILED } }),
      this.submissionRepo.findOne({ order: { createdAt: 'DESC' } }),
    ]);

    return { totalSubmissions, pending, confirmed, failed, lastSubmission };
  }

  async getSubmissions(query: OracleQueryDto): Promise<PaginatedList<OracleSubmission>> {
    const qb = this.submissionRepo.createQueryBuilder('submission');

    if (query.projectId) {
      qb.andWhere('submission.project_id = :projectId', { projectId: query.projectId });
    }
    if (query.oracleAddress) {
      qb.andWhere('submission.oracle_address = :oracleAddress', {
        oracleAddress: query.oracleAddress,
      });
    }
    if (query.status) {
      qb.andWhere('submission.status = :status', { status: query.status });
    }
    if (query.startDate) {
      qb.andWhere('submission.created_at >= :startDate', { startDate: query.startDate });
    }
    if (query.endDate) {
      qb.andWhere('submission.created_at <= :endDate', { endDate: query.endDate });
    }

    return paginate(
      qb,
      { alias: 'submission', sortColumn: 'submission.created_at', sortProperty: 'createdAt' },
      query,
    );
  }

  async getPendingSubmissions(): Promise<OracleSubmission[]> {
    return this.submissionRepo.find({
      where: { status: SubmissionStatus.PENDING },
      order: { createdAt: 'ASC' },
    });
  }

  async triggerSubmission(dto: TriggerSubmissionDto): Promise<OracleSubmission> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    let saved: OracleSubmission;
    try {
      // PostgreSQL advisory lock keyed on a hash of the oracle address.
      // This serialises concurrent callers even when no rows exist yet for
      // that oracle (which the FOR UPDATE on MAX(nonce) below cannot lock).
      await queryRunner.query(
        `SELECT pg_advisory_xact_lock(hashtext('oracle_nonce'), hashtext($1))`,
        [dto.oracleAddress],
      );

      const [row]: [{ max_nonce: string | null }] = await queryRunner.query(
        `SELECT MAX(nonce) AS max_nonce
           FROM oracle_submissions
          WHERE oracle_address = $1
          FOR UPDATE`,
        [dto.oracleAddress],
      );
      const nonce = (row.max_nonce !== null ? parseInt(row.max_nonce, 10) : 0) + 1;

      const submission = queryRunner.manager.create(OracleSubmission, {
        projectId: dto.projectId,
        oracleAddress: dto.oracleAddress,
        nonce,
        txHash: '',
        status: SubmissionStatus.PENDING,
        readingsSnapshot: dto.readings ?? {},
      });

      saved = await queryRunner.manager.save(OracleSubmission, submission);
      await queryRunner.commitTransaction();
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }

    await this.oracleQueue.add(
      'oracle-submit-job',
      {
        submissionId: saved.id,
        projectId: dto.projectId,
        oracleAddress: dto.oracleAddress,
        nonce: saved.nonce,
      },
      {
        attempts: 3,
        backoff: { type: 'fixed', delay: 10000 },
        removeOnComplete: 50,
      },
    );

    this.logger.log(`Queued oracle submission ${saved.id} for project ${dto.projectId}`);
    return saved;
  }

  /**
   * Aggregates verified sensor readings for a project.
   *
   * Medians are calculated with PostgreSQL's `percentile_cont(0.5)` directly
   * over the canonical `sensor_readings` table, filtered by project, time range
   * and `is_verified = true`.
   */
  async aggregateReadings(
    projectId: string,
    startTime?: Date,
    endTime?: Date,
  ): Promise<AggregatedReading> {
    const qb = this.buildAggregationQuery(projectId);

    if (startTime && endTime) {
      qb.andWhere('reading.timestamp BETWEEN :startTime AND :endTime', { startTime, endTime });
    }

    return this.runAggregation(qb);
  }

  /**
   * Aggregates the verified readings belonging to a single reading batch.
   *
   * Used by the scheduled submission cycle: selecting by `batch_id` (rather
   * than by a time range over device-reported timestamps) guarantees the
   * submission covers exactly the readings the batch collected.
   */
  async aggregateReadingsForBatch(projectId: string, batchId: string): Promise<AggregatedReading> {
    const qb = this.buildAggregationQuery(projectId);
    qb.andWhere('reading.batch_id = :batchId', { batchId });
    return this.runAggregation(qb);
  }

  private buildAggregationQuery(projectId: string): SelectQueryBuilder<SensorReading> {
    const qb = this.readingRepo.createQueryBuilder('reading');

    qb.select('percentile_cont(0.5) WITHIN GROUP (ORDER BY reading.ph)', 'medianPh')
      .addSelect(
        'percentile_cont(0.5) WITHIN GROUP (ORDER BY reading.turbidity)',
        'medianTurbidity',
      )
      .addSelect(
        'percentile_cont(0.5) WITHIN GROUP (ORDER BY reading.dissolved_oxygen)',
        'medianDissolvedOxygen',
      )
      .addSelect('percentile_cont(0.5) WITHIN GROUP (ORDER BY reading.flow_rate)', 'medianFlowRate')
      .addSelect('percentile_cont(0.5) WITHIN GROUP (ORDER BY reading.nitrogen)', 'medianNitrogen')
      .addSelect(
        'percentile_cont(0.5) WITHIN GROUP (ORDER BY reading.phosphorus)',
        'medianPhosphorus',
      )
      .addSelect(
        'percentile_cont(0.5) WITHIN GROUP (ORDER BY reading.temperature)',
        'medianTemperature',
      )
      .addSelect('COUNT(*)', 'oracleCount')
      .addSelect('MIN(reading.timestamp)', 'startTime')
      .addSelect('MAX(reading.timestamp)', 'endTime')
      .where('reading.project_id = :projectId', { projectId })
      .andWhere('reading.is_verified = true');

    return qb;
  }

  private async runAggregation(qb: SelectQueryBuilder<SensorReading>): Promise<AggregatedReading> {
    const row = await qb.getRawOne<AggregationRow>();

    if (!row || parseInt(row.oracleCount, 10) === 0) {
      throw new NotFoundException('No verified sensor readings found for aggregation');
    }

    return {
      medianPh: this.nullableNumber(row.medianPh),
      medianTurbidity: this.nullableNumber(row.medianTurbidity),
      medianDissolvedOxygen: this.nullableNumber(row.medianDissolvedOxygen),
      medianFlowRate: this.nullableNumber(row.medianFlowRate),
      medianNitrogen: this.nullableNumber(row.medianNitrogen),
      medianPhosphorus: this.nullableNumber(row.medianPhosphorus),
      medianTemperature: this.nullableNumber(row.medianTemperature),
      oracleCount: parseInt(row.oracleCount, 10),
      startTime: row.startTime ?? new Date(),
      endTime: row.endTime ?? new Date(),
    };
  }

  // ── Nonce-gap detection ─────────────────────────────────────────────────

  /**
   * Logs a warning when the local max confirmed nonce diverges from the
   * on-chain oracle nonce by more than 1 (indicating a missed or desynced
   * submission).
   */
  async detectNonceDrift(oracleContractId: string, oracleAddress: string): Promise<void> {
    const localMax = await this.submissionRepo.findOne({
      where: { oracleAddress, status: SubmissionStatus.CONFIRMED },
      order: { nonce: 'DESC' },
    });
    const localNonce = localMax?.nonce ?? 0;

    let onChainNonce: number;
    try {
      onChainNonce = await this.stellarService.getOracleNonce(oracleContractId, oracleAddress);
    } catch {
      this.logger.warn(`detectNonceDrift: could not read on-chain nonce for ${oracleAddress}`);
      return;
    }

    const diff = onChainNonce - localNonce;
    if (Math.abs(diff) > 1) {
      this.logger.warn(
        `Nonce drift detected for oracle ${oracleAddress}: ` +
          `local=${localNonce} on-chain=${onChainNonce} diff=${diff}`,
      );
    }
  }

  /**
   * Finds confirmed submissions whose nonce is greater than the given
   * on-chain nonce (stale / likely invalid on chain).
   */
  async findStaleSubmissions(
    oracleContractId: string,
    oracleAddress: string,
  ): Promise<OracleSubmission[]> {
    let onChainNonce: number;
    try {
      onChainNonce = await this.stellarService.getOracleNonce(oracleContractId, oracleAddress);
    } catch {
      return [];
    }

    return this.submissionRepo.find({
      where: {
        oracleAddress,
        status: SubmissionStatus.CONFIRMED,
        nonce: MoreThan(onChainNonce),
      },
      order: { nonce: 'ASC' },
    });
  }

  private nullableNumber(value: string | null): number | null {
    return value === null ? null : parseFloat(value);
  }
}
