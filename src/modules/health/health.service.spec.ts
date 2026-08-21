import { ConfigService } from '@nestjs/config';
import { getQueueToken } from '@nestjs/bull';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { HealthService } from './health.service';
import { StellarClient } from '../stellar/stellar.client';
import { IndexerService } from '../indexer/indexer.service';
import { OracleScheduleState } from '../oracle/entities/oracle-schedule-state.entity';

describe('HealthService checkStellar signing_ready', () => {
  async function buildService(opts: {
    signingReady: boolean;
    getLatestLedger?: () => Promise<{ sequence: number }>;
  }) {
    const getLatestLedger = opts.getLatestLedger ?? (async () => ({ sequence: 100 }));

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
          useValue: { findOne: jest.fn().mockResolvedValue(null) },
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
});
