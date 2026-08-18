import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { ConfigService } from '@nestjs/config';
import { StellarClient } from '../stellar/stellar.client';
import {
  GLOBAL_SCHEDULE_SCOPE,
  OracleScheduleState,
} from '../oracle/entities/oracle-schedule-state.entity';
import {
  DEFAULT_ORACLE_STALENESS_THRESHOLD_S,
  DEFAULT_ORACLE_SUBMISSION_CRON,
} from '../../config/oracle.config';

export interface ComponentHealth {
  status: 'ok' | 'degraded' | 'down';
  latency_ms?: number;
  detail?: string;
}

export interface QueueHealth {
  status: 'ok' | 'degraded' | 'down';
  waiting: number;
  active: number;
  failed: number;
}

/**
 * Freshness of the scheduled oracle submission cycle (Issue #44).
 *
 * `last_scheduled_at` is written by OracleSchedulerService at the end of every
 * cycle — including cycles that find nothing to submit — so a stale value means
 * the cron itself stopped firing, not merely that no batches were due.
 */
export interface OracleHealth {
  status: 'ok' | 'degraded' | 'down';
  enabled: boolean;
  cron: string;
  last_scheduled_at: string | null;
  staleness_s: number | null;
  last_submission_count: number | null;
  detail?: string;
}

export interface HealthReport {
  status: 'ok' | 'degraded' | 'down';
  timestamp: string;
  uptime_s: number;
  checks: {
    database: ComponentHealth;
    redis: ComponentHealth;
    stellar: ComponentHealth;
    oracle: OracleHealth;
    queues: Record<string, QueueHealth>;
  };
}

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);
  private readonly startTime = Date.now();

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    @InjectQueue('sensor-ingestion')
    private readonly sensorQueue: Queue,
    @InjectQueue('oracle-submit')
    private readonly oracleQueue: Queue,
    @InjectQueue('retirements')
    private readonly retirementQueue: Queue,
    @InjectRepository(OracleScheduleState)
    private readonly scheduleStateRepo: Repository<OracleScheduleState>,
    private readonly configService: ConfigService,
    private readonly stellarClient: StellarClient,
  ) {}

  async getHealth(): Promise<HealthReport> {
    const [database, redis, stellar, oracle, queues] = await Promise.all([
      this.checkDatabase(),
      this.checkRedis(),
      this.checkStellar(),
      this.checkOracleFreshness(),
      this.checkQueues(),
    ]);

    const componentStatuses = [database.status, redis.status, stellar.status, oracle.status];
    const queueStatuses = Object.values(queues).map((q) => q.status);
    const allStatuses = [...componentStatuses, ...queueStatuses];

    let overallStatus: 'ok' | 'degraded' | 'down' = 'ok';
    if (allStatuses.some((s) => s === 'down')) {
      overallStatus = 'down';
    } else if (allStatuses.some((s) => s === 'degraded')) {
      overallStatus = 'degraded';
    }

    return {
      status: overallStatus,
      timestamp: new Date().toISOString(),
      uptime_s: Math.floor((Date.now() - this.startTime) / 1000),
      checks: { database, redis, stellar, oracle, queues },
    };
  }

  private async checkDatabase(): Promise<ComponentHealth> {
    const start = Date.now();
    try {
      await this.dataSource.query('SELECT 1');
      return { status: 'ok', latency_ms: Date.now() - start };
    } catch (err) {
      this.logger.warn(`Database health check failed: ${(err as Error).message}`);
      return { status: 'down', detail: (err as Error).message };
    }
  }

  private async checkRedis(): Promise<ComponentHealth> {
    const start = Date.now();
    try {
      // Bull queues use ioredis under the hood; a simple isReady check suffices
      const client = await this.sensorQueue.client;
      await (client as unknown as { ping: () => Promise<string> }).ping();
      return { status: 'ok', latency_ms: Date.now() - start };
    } catch (err) {
      this.logger.warn(`Redis health check failed: ${(err as Error).message}`);
      return { status: 'down', detail: (err as Error).message };
    }
  }

  private async checkStellar(): Promise<ComponentHealth> {
    const start = Date.now();
    try {
      const server = this.stellarClient.getServer();
      const ledger = await server.getLatestLedger();
      return {
        status: 'ok',
        latency_ms: Date.now() - start,
        detail: `latest_ledger=${ledger.sequence}`,
      };
    } catch (err) {
      this.logger.warn(`Stellar RPC health check failed: ${(err as Error).message}`);
      return { status: 'degraded', detail: (err as Error).message };
    }
  }

  /**
   * Reports how long ago the oracle submission cycle last ran.  Never returns
   * 'down' — a stale oracle degrades the report but must not take a node out
   * of a load-balancer rotation that is otherwise healthy.
   */
  private async checkOracleFreshness(): Promise<OracleHealth> {
    const enabled = this.configService.get<boolean>('oracle.schedulerEnabled', true);
    const cron = this.configService.get<string>(
      'oracle.submissionIntervalCron',
      DEFAULT_ORACLE_SUBMISSION_CRON,
    );
    const thresholdSeconds = this.configService.get<number>(
      'oracle.stalenessThresholdSeconds',
      DEFAULT_ORACLE_STALENESS_THRESHOLD_S,
    );

    const base: OracleHealth = {
      status: 'ok',
      enabled,
      cron,
      last_scheduled_at: null,
      staleness_s: null,
      last_submission_count: null,
    };

    if (!enabled) {
      return { ...base, detail: 'scheduler disabled via ORACLE_SCHEDULER_ENABLED=false' };
    }

    let state: OracleScheduleState | null;
    try {
      state = await this.scheduleStateRepo.findOne({
        where: { scopeId: GLOBAL_SCHEDULE_SCOPE },
      });
    } catch (err) {
      this.logger.warn(`Oracle freshness check failed: ${(err as Error).message}`);
      return { ...base, status: 'degraded', detail: (err as Error).message };
    }

    if (!state?.lastScheduledAt) {
      return { ...base, detail: 'no submission cycle has run yet' };
    }

    const stalenessSeconds = Math.floor(
      (Date.now() - new Date(state.lastScheduledAt).getTime()) / 1000,
    );
    const stale = stalenessSeconds > thresholdSeconds;

    return {
      status: stale ? 'degraded' : 'ok',
      enabled,
      cron,
      last_scheduled_at: new Date(state.lastScheduledAt).toISOString(),
      staleness_s: stalenessSeconds,
      last_submission_count: state.lastSubmissionCount,
      ...(stale
        ? { detail: `last cycle was ${stalenessSeconds}s ago (threshold ${thresholdSeconds}s)` }
        : {}),
    };
  }

  private async checkQueues(): Promise<Record<string, QueueHealth>> {
    const queues: Array<{ name: string; queue: Queue }> = [
      { name: 'sensor-ingestion', queue: this.sensorQueue },
      { name: 'oracle-submit', queue: this.oracleQueue },
      { name: 'retirements', queue: this.retirementQueue },
    ];

    const results: Record<string, QueueHealth> = {};

    for (const { name, queue } of queues) {
      try {
        const [waiting, active, failed] = await Promise.all([
          queue.getWaitingCount(),
          queue.getActiveCount(),
          queue.getFailedCount(),
        ]);

        const status: 'ok' | 'degraded' = failed > 10 ? 'degraded' : 'ok';
        results[name] = { status, waiting, active, failed };
      } catch {
        results[name] = { status: 'down', waiting: -1, active: -1, failed: -1 };
      }
    }

    return results;
  }
}
