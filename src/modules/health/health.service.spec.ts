import { ConfigService } from '@nestjs/config';
import { getQueueToken } from '@nestjs/bull';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { HealthService } from './health.service';
import { StellarClient } from '../stellar/stellar.client';
import { IndexerService } from '../indexer/indexer.service';
import { OracleScheduleState } from '../oracle/entities/oracle-schedule-state.entity';
import { RedisService } from '../auth/redis.service';

describe('HealthService checkStellar signing_ready', () => {
  async function buildService(opts: {
    signingReady: boolean;
    getLatestLedger?: () => Promise<{ sequence: number }>;
    authRedisPing?: () => Promise<void>;
    scheduleState?: Partial<{ lastScheduledAt: Date; lastSubmissionCount: number; lastNonceDrift: number | null }> | null;
  }) {
    const getLatestLedger = opts.getLatestLedger ?? (async () => ({ sequence: 100 }));
    const authRedisPing = opts.authRedisPing ?? (async () => undefined);
    const scheduleState = opts.scheduleState === undefined ? null : opts.scheduleState;

    const moduleRef = await Test.createTestingModule({
      providers: [
        HealthService,
        {
          provide: DataSource,
          useValue: { query: jest.fn().mockResolvedValue([{ '?column?': 1 }]) },
        },
        { provide: getDataSourceToken(), useValue: { query: jest.fn() } },
        {
          provide: getQueueToken('sensor-ingestion'),
          useValue: {
            client: Promise.resolve({ ping: async () => 'PONG' }),
            getWaitingCount: async () => 0,
            getActiveCount: async () => 0,
            getFailedCount: async () => 0,
          },
        },
        {
          provide: getQueueToken('oracle-submit'),
          useValue: {
            getWaitingCount: async () => 0,
            getActiveCount: async () => 0,
            getFailedCount: async () => 0,
          },
        },
        {
          provide: getQueueToken('retirements'),
          useValue: {
            getWaitingCount: async () => 0,
            getActiveCount: async () => 0,
            getFailedCount: async () => 0,
          },
        },
        {
          provide: getRepositoryToken(OracleScheduleState),
          useValue: { findOne: jest.fn().mockResolvedValue(scheduleState) },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((_key: string, fallback?: unknown) => fallback),
          },
        },
        {
          provide: StellarClient,
          useValue: {
            isSigningReady: () => opts.signingReady,
            getServer: () => ({ getLatestLedger }),
          },
        },
        {
          provide: IndexerService,
          useValue: {
            getIndexerStatus: jest.fn().mockResolvedValue({
              status: 'ok',
              lastIndexedLedger: 99,
              chainTipLedger: 100,
              lag: 1,
            }),
          },
        },
        {
          provide: RedisService,
          useValue: { ping: authRedisPing },
        },
      ],
    }).compile();

    return moduleRef.get(HealthService);
  }

  it('sets signing_ready true and stellar ok when secret is configured', async () => {
    const service = await buildService({ signingReady: true });
    const report = await service.getHealth();

    expect(report.checks.stellar.signing_ready).toBe(true);
    expect(report.checks.stellar.status).toBe('ok');
    expect(report.status).toBe('ok');
  });

  it('sets signing_ready false and degrades when secret is unconfigured', async () => {
    const service = await buildService({ signingReady: false });
    const report = await service.getHealth();

    expect(report.checks.stellar.signing_ready).toBe(false);
    expect(report.checks.stellar.status).toBe('degraded');
    expect(report.status).toBe('degraded');
    expect(report.checks.stellar.detail).toMatch(/STELLAR_BACKEND_SECRET not configured/);
  });

  it('keeps signing_ready true when RPC fails', async () => {
    const service = await buildService({
      signingReady: true,
      getLatestLedger: async () => {
        throw new Error('rpc down');
      },
    });
    const report = await service.getHealth();

    expect(report.checks.stellar.signing_ready).toBe(true);
    expect(report.checks.stellar.status).toBe('degraded');
    expect(report.checks.stellar.detail).toBe('rpc down');
  });

  // ── authRedis (#88) ──────────────────────────────────────────────────

  it('reports authRedis ok and does not affect overall status when the auth Redis client is reachable', async () => {
    const service = await buildService({ signingReady: true });
    const report = await service.getHealth();

    expect(report.checks.authRedis.status).toBe('ok');
    expect(report.status).toBe('ok');
  });

  it('reports authRedis down and degrades the overall report when the auth Redis client is unreachable', async () => {
    const service = await buildService({
      signingReady: true,
      authRedisPing: async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:6379');
      },
    });
    const report = await service.getHealth();

    expect(report.checks.authRedis.status).toBe('down');
    expect(report.checks.authRedis.detail).toBe('connect ECONNREFUSED 127.0.0.1:6379');
    // A down component takes precedence over the 'ok' otherwise-healthy checks.
    expect(report.status).toBe('down');
  });

  it('keeps the authRedis check independent from the Bull-queue redis check', async () => {
    // Bull's queue Redis (checked via checkRedis) is healthy in every fixture
    // here; this asserts authRedis is a genuinely separate component rather
    // than reusing/aliasing that same check.
    const service = await buildService({
      signingReady: true,
      authRedisPing: async () => {
        throw new Error('auth redis down');
      },
    });
    const report = await service.getHealth();

    expect(report.checks.redis.status).toBe('ok');
    expect(report.checks.authRedis.status).toBe('down');
  });

  // ── nonce_drift (#119) ───────────────────────────────────────────────

  it('includes nonce_drift=null when no schedule state exists yet', async () => {
    const service = await buildService({ signingReady: true });
    const report = await service.getHealth();

    expect(report.checks.oracle.nonce_drift).toBeNull();
  });

  it('includes nonce_drift=0 when drift is zero', async () => {
    const service = await buildService({
      signingReady: true,
      scheduleState: {
        lastScheduledAt: new Date(Date.now() - 30_000),
        lastSubmissionCount: 1,
        lastNonceDrift: 0,
      },
    });
    const report = await service.getHealth();

    expect(report.checks.oracle.nonce_drift).toBe(0);
    expect(report.checks.oracle.status).toBe('ok');
  });

  it('sets oracle status=degraded and surfaces nonce_drift when drift > 1', async () => {
    const service = await buildService({
      signingReady: true,
      scheduleState: {
        lastScheduledAt: new Date(Date.now() - 30_000),
        lastSubmissionCount: 2,
        lastNonceDrift: 3,
      },
    });
    const report = await service.getHealth();

    expect(report.checks.oracle.nonce_drift).toBe(3);
    expect(report.checks.oracle.status).toBe('degraded');
    expect(report.checks.oracle.detail).toMatch(/nonce drift=3/);
    expect(report.status).toBe('degraded');
  });

  it('sets oracle status=degraded for negative drift > 1 in magnitude', async () => {
    const service = await buildService({
      signingReady: true,
      scheduleState: {
        lastScheduledAt: new Date(Date.now() - 30_000),
        lastSubmissionCount: 1,
        lastNonceDrift: -2,
      },
    });
    const report = await service.getHealth();

    expect(report.checks.oracle.nonce_drift).toBe(-2);
    expect(report.checks.oracle.status).toBe('degraded');
  });

  it('keeps oracle status=ok when drift is exactly 1', async () => {
    const service = await buildService({
      signingReady: true,
      scheduleState: {
        lastScheduledAt: new Date(Date.now() - 30_000),
        lastSubmissionCount: 1,
        lastNonceDrift: 1,
      },
    });
    const report = await service.getHealth();

    expect(report.checks.oracle.nonce_drift).toBe(1);
    expect(report.checks.oracle.status).toBe('ok');
  });

  it('sets nonce_drift=null when lastNonceDrift is null (RPC failed during last cycle)', async () => {
    const service = await buildService({
      signingReady: true,
      scheduleState: {
        lastScheduledAt: new Date(Date.now() - 30_000),
        lastSubmissionCount: 1,
        lastNonceDrift: null,
      },
    });
    const report = await service.getHealth();

    expect(report.checks.oracle.nonce_drift).toBeNull();
    expect(report.checks.oracle.status).toBe('ok');
  });

  it('combines staleness and drift degradation in the detail string', async () => {
    const service = await buildService({
      signingReady: true,
      scheduleState: {
        lastScheduledAt: new Date(Date.now() - 3 * 3600 * 1000), // 3h ago, default threshold 2h
        lastSubmissionCount: 0,
        lastNonceDrift: 5,
      },
    });
    const report = await service.getHealth();

    expect(report.checks.oracle.status).toBe('degraded');
    expect(report.checks.oracle.detail).toMatch(/last cycle was/);
    expect(report.checks.oracle.detail).toMatch(/nonce drift=5/);
  });
});
