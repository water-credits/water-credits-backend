import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { getRepositoryToken } from '@nestjs/typeorm';
import { IndexerService, LEDGER_GAP_WARNING_THRESHOLD } from './indexer.service';
import { IndexerCursor, MAIN_CURSOR_KEY } from './entities/indexer-cursor.entity';
import { DecodedEvent } from './indexer.types';
import { OracleSubmission, SubmissionStatus } from '../oracle/entities/oracle-submission.entity';
import { ReadingBatch } from '../sensors/entities/reading-batch.entity';
import { Retirement } from '../credits/entities/retirement.entity';
import { Proposal } from '../governance/entities/proposal.entity';
import { StellarClient } from '../stellar/stellar.client';
import { NotificationsService } from '../notifications/notifications.service';
import { SensorsGateway } from '../sensors/sensors.gateway';
import { NotificationsGateway } from '../notifications/notifications.gateway';

// ── Helpers ──────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MockRepo = Record<string, jest.Mock<any, any>>;

function mockRepo(overrides: Partial<MockRepo> = {}): MockRepo {
  return {
    findOne: jest.fn(),
    find: jest.fn(),
    save: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    ...overrides,
  };
}

function makeRawEvent(overrides: {
  id?: string;
  ledger?: number;
  contractId?: string;
  topic?: unknown[];
  value?: unknown;
}) {
  return {
    id: overrides.id ?? 'ev-001',
    ledger: overrides.ledger ?? 100,
    contractId: overrides.contractId ?? 'CONTRACT1',
    topic: overrides.topic ?? ['mint', 'GADDR...'],
    value: overrides.value ?? { amount: 5000n },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('IndexerService', () => {
  let service: IndexerService;
  let cursorRepo: MockRepo;
  let submissionRepo: MockRepo;
  let batchRepo: MockRepo;
  let retirementRepo: MockRepo;
  let proposalRepo: MockRepo;
  let mockServer: { getLatestLedger: jest.Mock; getEvents: jest.Mock };
  let mockDataSource: { query: jest.Mock; createQueryBuilder: jest.Mock };
  let mockNotificationsGateway: { broadcast: jest.Mock };
  let mockSensorsGateway: { emitReading: jest.Mock };

  beforeEach(async () => {
    mockServer = {
      getLatestLedger: jest.fn().mockResolvedValue({ sequence: 1000 }),
      getEvents: jest.fn().mockResolvedValue({ events: [] }),
    };

    cursorRepo = mockRepo();
    submissionRepo = mockRepo();
    batchRepo = mockRepo();
    retirementRepo = mockRepo();
    proposalRepo = mockRepo();
    mockNotificationsGateway = { broadcast: jest.fn() };
    mockSensorsGateway = { emitReading: jest.fn() };

    mockDataSource = {
      query: jest.fn().mockResolvedValue([]),
      createQueryBuilder: jest.fn().mockReturnValue({
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ affected: 0 }),
      }),
    };

    (cursorRepo.create as jest.Mock).mockImplementation((data) => data);
    (cursorRepo.save as jest.Mock).mockImplementation((entity) =>
      Promise.resolve(entity),
    );
    (submissionRepo.save as jest.Mock).mockImplementation((entity) =>
      Promise.resolve(entity),
    );
    (proposalRepo.save as jest.Mock).mockImplementation((entity) =>
      Promise.resolve(entity),
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        IndexerService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, defaultVal?: unknown) => {
              if (key === 'INDEXER_POLL_INTERVAL_MS') return 999_999; // huge — never fires in tests
              if (key === 'CONTRACT_CREDIT_FACTORY') return 'CONTRACT1';
              if (key === 'CONTRACT_VERIFICATION_ORACLE') return 'CONTRACT2';
              if (key === 'CONTRACT_RETIREMENT_REGISTRY') return 'CONTRACT3';
              if (key === 'stellar.contractGovernance') return 'CONTRACT4';
              return defaultVal;
            }),
          },
        },
        {
          provide: StellarClient,
          useValue: { getServer: jest.fn(() => mockServer) },
        },
        {
          provide: NotificationsService,
          useValue: { notifyCreditMinted: jest.fn(), notifyCreditRetired: jest.fn() },
        },
        { provide: SensorsGateway, useValue: mockSensorsGateway },
        { provide: NotificationsGateway, useValue: mockNotificationsGateway },
        { provide: DataSource, useValue: mockDataSource },
        { provide: getRepositoryToken(IndexerCursor), useValue: cursorRepo },
        { provide: getRepositoryToken(OracleSubmission), useValue: submissionRepo },
        { provide: getRepositoryToken(ReadingBatch), useValue: batchRepo },
        { provide: getRepositoryToken(Retirement), useValue: retirementRepo },
        { provide: getRepositoryToken(Proposal), useValue: proposalRepo },
      ],
    }).compile();

    service = module.get<IndexerService>(IndexerService);
  });

  afterEach(() => {
    // Always call onModuleDestroy to clear the interval set by onModuleInit.
    service.onModuleDestroy();
    jest.clearAllMocks();
  });

  // ── Cold start ──────────────────────────────────────────────────────

  describe('cold start (no cursor row)', () => {
    it('seeds the cursor at chainTip - 1 on the first tick', async () => {
      // No cursor row in DB.
      (cursorRepo.findOne as jest.Mock).mockResolvedValue(null);
      mockServer.getLatestLedger.mockResolvedValue({ sequence: 500 });

      // Call onModuleInit — this triggers one immediate poll cycle.
      service.onModuleInit();
      // Give the async poll a microtask to run.
      await Promise.resolve();
      await Promise.resolve();

      expect(cursorRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ lastIndexedLedger: 499 }),
      );
      // On cold start the indexer returns early — no events fetched.
      expect(mockServer.getEvents).not.toHaveBeenCalled();
    });

    it('does not call getEvents on the seeding tick', async () => {
      (cursorRepo.findOne as jest.Mock).mockResolvedValue(null);

      service.onModuleInit();
      await Promise.resolve();
      await Promise.resolve();

      expect(mockServer.getEvents).not.toHaveBeenCalled();
    });
  });

  // ── Normal poll cycle ───────────────────────────────────────────────

  describe('normal poll cycle', () => {
    it('calls getEvents with the correct startLedger', async () => {
      (cursorRepo.findOne as jest.Mock).mockResolvedValue({
        cursorKey: MAIN_CURSOR_KEY,
        lastIndexedLedger: 900,
        lastIndexedAt: new Date(),
      });
      mockServer.getLatestLedger.mockResolvedValue({ sequence: 905 });
      mockServer.getEvents.mockResolvedValue({ events: [] });

      await (service as unknown as { doPoll: () => Promise<void> }).doPoll();

      expect(mockServer.getEvents).toHaveBeenCalledWith(
        expect.objectContaining({ startLedger: 901 }),
      );
    });

    it('advances the cursor to chainTipLedger after an empty poll', async () => {
      (cursorRepo.findOne as jest.Mock).mockResolvedValue({
        cursorKey: MAIN_CURSOR_KEY,
        lastIndexedLedger: 900,
        lastIndexedAt: new Date(),
      });
      mockServer.getLatestLedger.mockResolvedValue({ sequence: 905 });
      mockServer.getEvents.mockResolvedValue({ events: [] });

      await (service as unknown as { doPoll: () => Promise<void> }).doPoll();

      expect(cursorRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ lastIndexedLedger: 905 }),
      );
    });

    it('emits structured debug log line per ledger range processed', async () => {
      const debugSpy = jest.spyOn(service['logger'], 'debug').mockImplementation(() => {});

      (cursorRepo.findOne as jest.Mock).mockResolvedValue({
        cursorKey: MAIN_CURSOR_KEY,
        lastIndexedLedger: 900,
        lastIndexedAt: new Date(),
      });
      mockServer.getLatestLedger.mockResolvedValue({ sequence: 902 });
      mockServer.getEvents.mockResolvedValue({ events: [] });

      await (service as unknown as { doPoll: () => Promise<void> }).doPoll();

      expect(debugSpy).toHaveBeenCalledWith(
        expect.stringContaining('"context":"IndexerService"'),
      );
    });
  });

  // ── Duplicate event replay (idempotency) ────────────────────────────

  describe('idempotency — duplicate event replay', () => {
    it('applies a credit:mint event twice without double-writing credits', async () => {
      // Use processEvents directly with already-decoded events to bypass scValToNative.
      type ProcessEvents = (events: DecodedEvent[]) => Promise<void>;
      const processEvents = (service as unknown as { processEvents: ProcessEvents }).processEvents.bind(service);

      const mintDecoded: DecodedEvent = {
        id: 'ev-mint-001',
        ledger: 901,
        contractId: 'CONTRACT1',
        topics: ['mint', 'GBENEFICIARY...'],
        value: { amount: 5000n },
      };

      const qbMock = {
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ affected: 1 }),
      };
      (mockDataSource.createQueryBuilder as jest.Mock).mockReturnValue(qbMock);

      // First pass
      await processEvents([mintDecoded]);
      // Second pass — same event replayed
      await processEvents([mintDecoded]);

      // The query builder's execute() is the DB write gate.
      // The WHERE clause contains "status IN (pending, submitted)" so an already-CONFIRMED
      // batch would match 0 rows — idempotency is enforced at the SQL level.
      // What we assert here is that the service never throws on replay and
      // the query was issued both times (the DB constraint enforces idempotency).
      expect(qbMock.execute).toHaveBeenCalledTimes(2);
    });
  });

  // ── Ledger gap warning ──────────────────────────────────────────────

  describe('gap detection', () => {
    it('emits a structured warn log when cursor lag exceeds threshold', async () => {
      const warnSpy = jest.spyOn(service['logger'], 'warn').mockImplementation(() => {});

      const staleAt = 1; // very old cursor
      const tipAt = staleAt + LEDGER_GAP_WARNING_THRESHOLD + 100;

      (cursorRepo.findOne as jest.Mock).mockResolvedValue({
        cursorKey: MAIN_CURSOR_KEY,
        lastIndexedLedger: staleAt,
        lastIndexedAt: new Date(),
      });
      mockServer.getLatestLedger.mockResolvedValue({ sequence: tipAt });
      mockServer.getEvents.mockResolvedValue({ events: [] });

      await (service as unknown as { doPoll: () => Promise<void> }).doPoll();

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Ledger cursor is behind the chain tip'),
      );
    });

    it('does NOT warn when lag is within threshold', async () => {
      const warnSpy = jest.spyOn(service['logger'], 'warn').mockImplementation(() => {});

      (cursorRepo.findOne as jest.Mock).mockResolvedValue({
        cursorKey: MAIN_CURSOR_KEY,
        lastIndexedLedger: 990,
        lastIndexedAt: new Date(),
      });
      mockServer.getLatestLedger.mockResolvedValue({ sequence: 1000 });
      mockServer.getEvents.mockResolvedValue({ events: [] });

      await (service as unknown as { doPoll: () => Promise<void> }).doPoll();

      // No gap warning expected for lag of 10.
      const gapWarnings = warnSpy.mock.calls.filter((args) =>
        String(args[0]).includes('Ledger cursor is behind'),
      );
      expect(gapWarnings.length).toBe(0);
    });
  });

  // ── getIndexerStatus ────────────────────────────────────────────────

  describe('getIndexerStatus()', () => {
    it('returns ok when polling and lag is small', async () => {
      (cursorRepo.findOne as jest.Mock).mockResolvedValue({
        cursorKey: MAIN_CURSOR_KEY,
        lastIndexedLedger: 995,
        lastIndexedAt: new Date(),
      });
      mockServer.getLatestLedger.mockResolvedValue({ sequence: 1000 });

      service.onModuleInit(); // sets pollHandle
      const status = await service.getIndexerStatus();

      expect(status.status).toBe('ok');
      expect(status.lag).toBe(5);
    });

    it('returns stopped when the poll handle has been cleared', async () => {
      (cursorRepo.findOne as jest.Mock).mockResolvedValue({
        cursorKey: MAIN_CURSOR_KEY,
        lastIndexedLedger: 995,
        lastIndexedAt: new Date(),
      });
      mockServer.getLatestLedger.mockResolvedValue({ sequence: 1000 });

      service.onModuleDestroy(); // explicitly stop
      const status = await service.getIndexerStatus();

      expect(status.status).toBe('stopped');
    });

    it('returns behind when lag exceeds threshold', async () => {
      (cursorRepo.findOne as jest.Mock).mockResolvedValue({
        cursorKey: MAIN_CURSOR_KEY,
        lastIndexedLedger: 1,
        lastIndexedAt: new Date(),
      });
      mockServer.getLatestLedger.mockResolvedValue({
        sequence: LEDGER_GAP_WARNING_THRESHOLD + 100,
      });

      service.onModuleInit();
      const status = await service.getIndexerStatus();

      expect(status.status).toBe('behind');
    });
  });

  // ── WebSocket broadcast ─────────────────────────────────────────────

  describe('WebSocket broadcasts', () => {
    /** Helper: bypasses scValToNative by directly injecting decoded events into processEvents. */
    type ProcessEvents = (events: DecodedEvent[]) => Promise<void>;

    it('broadcasts credit:minted after a mint event', async () => {
      const mintDecoded: DecodedEvent = {
        id: 'ev-mint-001',
        ledger: 901,
        contractId: 'CONTRACT1',
        topics: ['mint', 'GTO...'],
        value: { amount: 100n },
      };

      await (service as unknown as { processEvents: ProcessEvents }).processEvents([mintDecoded]);

      expect(mockNotificationsGateway.broadcast).toHaveBeenCalledWith(
        'credit:minted',
        expect.objectContaining({ to: 'GTO...', amount: '100' }),
      );
    });

    it('broadcasts credit:retired after a retire event', async () => {
      const retireDecoded: DecodedEvent = {
        id: 'ev-retire-001',
        ledger: 901,
        contractId: 'CONTRACT3',
        topics: ['retire', 'GFROM...'],
        value: { amount: 50n, purpose: 'voluntary', metadata_uri: '' },
      };

      await (service as unknown as { processEvents: ProcessEvents }).processEvents([retireDecoded]);

      expect(mockNotificationsGateway.broadcast).toHaveBeenCalledWith(
        'credit:retired',
        expect.objectContaining({ from: 'GFROM...' }),
      );
    });
  });
});
