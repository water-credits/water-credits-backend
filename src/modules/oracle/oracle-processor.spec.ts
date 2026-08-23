import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { SorobanRpc } from '@stellar/stellar-sdk';
import { OracleProcessor, mapSnapshotToPayload } from './oracle-processor';
import { OracleSubmission, SubmissionStatus } from './entities/oracle-submission.entity';
import { GovernanceConfig } from '../governance/entities/governance-config.entity';
import { StellarService } from '../stellar/stellar.service';
import { CreditScoringService } from './credit-scoring.service';
import { Project } from '../projects/entities/project.entity';
import { ReadingBatch } from '../sensors/entities/reading-batch.entity';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSubmission(overrides: Partial<OracleSubmission> = {}): OracleSubmission {
  return {
    id: 'sub-1',
    projectId: 'proj-1',
    oracleAddress: 'GABC123',
    nonce: 1,
    txHash: '',
    status: SubmissionStatus.PENDING,
    readingsSnapshot: {
      ph: 7.2,
      turbidity: 12.4,
      dissolvedOxygen: 6.8,
      flowRate: 1.834,
      nitrogen: 2.45,
      phosphorus: 0.125,
      temperature: 18.5,
    },
    result: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    project: undefined as never,
    ...overrides,
  };
}

function makeJob(
  data: Partial<{
    submissionId: string;
    projectId: string;
    oracleAddress: string;
    nonce: number;
  }> = {},
) {
  return {
    data: {
      submissionId: 'sub-1',
      projectId: 'proj-1',
      oracleAddress: 'GABC123',
      nonce: 1,
      ...data,
    },
  } as never;
}

const SUCCESS_RESPONSE = {
  status: SorobanRpc.Api.GetTransactionStatus.SUCCESS,
  ledger: 12345,
} as SorobanRpc.Api.GetSuccessfulTransactionResponse;

// ---------------------------------------------------------------------------
// Unit tests for mapSnapshotToPayload (exported pure function)
// ---------------------------------------------------------------------------

describe('mapSnapshotToPayload', () => {
  it('maps a full camelCase snapshot to a complete payload', () => {
    const snapshot = {
      ph: 7.2,
      turbidity: 12.4,
      dissolvedOxygen: 6.8,
      flowRate: 1.834,
      nitrogen: 2.45,
      phosphorus: 0.125,
      temperature: 18.5,
    };
    const payload = mapSnapshotToPayload(snapshot);
    expect(payload).toEqual({
      ph: 7.2,
      turbidity: 12.4,
      dissolvedOxygen: 6.8,
      flowRate: 1.834,
      nitrogen: 2.45,
      phosphorus: 0.125,
      temperature: 18.5,
    });
  });

  it('maps a full snake_case snapshot to camelCase payload fields', () => {
    const snapshot = {
      ph: 7.0,
      turbidity_ntu: 15.0,
      dissolved_oxygen: 5.5,
      flow_rate_cms: 2.1,
      total_nitrogen_mgl: 3.0,
      total_phosphorus_mgl: 0.2,
      temperature_c: 20.0,
    };
    const payload = mapSnapshotToPayload(snapshot);
    expect(payload.ph).toBe(7.0);
    expect(payload.turbidity).toBe(15.0);
    expect(payload.dissolvedOxygen).toBe(5.5);
    expect(payload.flowRate).toBe(2.1);
    expect(payload.nitrogen).toBe(3.0);
    expect(payload.phosphorus).toBe(0.2);
    expect(payload.temperature).toBe(20.0);
  });

  it('sets absent parameters to null', () => {
    const payload = mapSnapshotToPayload({ ph: 7.0 });
    expect(payload.ph).toBe(7.0);
    expect(payload.turbidity).toBeNull();
    expect(payload.dissolvedOxygen).toBeNull();
    expect(payload.flowRate).toBeNull();
    expect(payload.nitrogen).toBeNull();
    expect(payload.phosphorus).toBeNull();
    expect(payload.temperature).toBeNull();
  });

  it('coerces string-encoded numbers', () => {
    const payload = mapSnapshotToPayload({ dissolvedOxygen: '6.5', ph: '7.1' });
    expect(payload.dissolvedOxygen).toBe(6.5);
    expect(payload.ph).toBe(7.1);
  });

  it('throws when the snapshot has no recognised numeric fields', () => {
    expect(() => mapSnapshotToPayload({})).toThrow(/no recognisable numeric parameters/);
  });

  it('throws when every recognised key is null/undefined', () => {
    expect(() => mapSnapshotToPayload({ ph: null, dissolvedOxygen: undefined })).toThrow(
      /no recognisable numeric parameters/,
    );
  });

  it('throws when only unrecognised keys are present', () => {
    expect(() => mapSnapshotToPayload({ salinity: 35, conductivity: 1200 })).toThrow(
      /no recognisable numeric parameters/,
    );
  });

  it('ignores non-finite values (NaN, Infinity)', () => {
    // NaN and Infinity should not satisfy the "has any value" check
    expect(() => mapSnapshotToPayload({ ph: NaN, dissolvedOxygen: Infinity })).toThrow(
      /no recognisable numeric parameters/,
    );
  });

  it('prefers camelCase over snake_case when both are present', () => {
    const payload = mapSnapshotToPayload({ dissolvedOxygen: 7.0, dissolved_oxygen: 5.0 });
    expect(payload.dissolvedOxygen).toBe(7.0);
  });
});

// ---------------------------------------------------------------------------
// Integration tests for OracleProcessor.processSubmission
// ---------------------------------------------------------------------------

describe('OracleProcessor', () => {
  let processor: OracleProcessor;

  // savedSnapshots records a shallow copy of the entity at the moment save()
  // was called, so tests can assert the status at each call point even though
  // the processor mutates the same object in place.
  let savedSnapshots: OracleSubmission[];

  let findOneMock: jest.Mock;
  let saveMock: jest.Mock;
  let submitReadingMock: jest.Mock;
  let getOracleNonceMock: jest.Mock;
  let configGetMock: jest.Mock;

  beforeEach(async () => {
    savedSnapshots = [];
    findOneMock = jest.fn();
    saveMock = jest.fn().mockImplementation((s: OracleSubmission) => {
      savedSnapshots.push({ ...s });
      return Promise.resolve({ ...s });
    });
    submitReadingMock = jest.fn();
    getOracleNonceMock = jest.fn().mockResolvedValue(0);
    configGetMock = jest.fn().mockReturnValue('CONTRACT_ORACLE_ID');

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OracleProcessor,
        {
          provide: getRepositoryToken(OracleSubmission),
          useValue: { findOne: findOneMock, save: saveMock },
        },
        {
          provide: getRepositoryToken(GovernanceConfig),
          useValue: { findOne: jest.fn().mockResolvedValue(null) },
        },
        {
          provide: getRepositoryToken(Project),
          useValue: { findOne: jest.fn().mockResolvedValue(null) },
        },
        {
          provide: getRepositoryToken(ReadingBatch),
          useValue: { findOne: jest.fn().mockResolvedValue(null), save: jest.fn() },
        },
        {
          provide: StellarService,
          useValue: {
            submitReading: submitReadingMock,
            getOracleNonce: getOracleNonceMock,
          },
        },
        { provide: ConfigService, useValue: { get: configGetMock } },
        { provide: CreditScoringService, useValue: { calculate: jest.fn() } },
      ],
    }).compile();

    processor = module.get<OracleProcessor>(OracleProcessor);
  });

  // ── submission not found ──────────────────────────────────────────────────

  it('skips gracefully when submission row is not found', async () => {
    findOneMock.mockResolvedValue(null);

    await expect(processor.processSubmission(makeJob())).resolves.toBeUndefined();
    expect(submitReadingMock).not.toHaveBeenCalled();
  });

  // ── terminal idempotency guard ────────────────────────────────────────────

  it('skips without re-submitting when already CONFIRMED', async () => {
    findOneMock.mockResolvedValue(makeSubmission({ status: SubmissionStatus.CONFIRMED }));

    await expect(processor.processSubmission(makeJob())).resolves.toBeUndefined();
    expect(submitReadingMock).not.toHaveBeenCalled();
  });

  it('re-tries FAILED submissions with the same nonce', async () => {
    findOneMock.mockResolvedValue(makeSubmission({ status: SubmissionStatus.FAILED, nonce: 3 }));
    getOracleNonceMock.mockResolvedValue(2);
    submitReadingMock.mockResolvedValue({
      txHash: 'retry-tx-hash',
      response: SUCCESS_RESPONSE,
    });

    await processor.processSubmission(makeJob({ nonce: 3 }));

    expect(submitReadingMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.any(Object),
      3,
    );
    expect(savedSnapshots).toHaveLength(2);
    expect(savedSnapshots[0].status).toBe(SubmissionStatus.SUBMITTED);
    expect(savedSnapshots[1].status).toBe(SubmissionStatus.CONFIRMED);
  });

  // ── oracle contract not configured ───────────────────────────────────────

  it('marks FAILED and throws when oracle contract ID is not configured', async () => {
    configGetMock.mockReturnValue('');
    findOneMock.mockResolvedValue(makeSubmission());

    await expect(processor.processSubmission(makeJob())).rejects.toThrow(
      'Oracle contract ID not configured',
    );

    expect(savedSnapshots).toHaveLength(1);
    expect(savedSnapshots[0].status).toBe(SubmissionStatus.FAILED);
    expect(submitReadingMock).not.toHaveBeenCalled();
  });

  // ── SUBMITTED → CONFIRMED ────────────────────────────────────────────────

  it('transitions PENDING → SUBMITTED → CONFIRMED and persists real txHash', async () => {
    findOneMock.mockResolvedValue(makeSubmission());
    submitReadingMock.mockResolvedValue({
      txHash: 'real-tx-hash-abc',
      response: SUCCESS_RESPONSE,
    });

    await processor.processSubmission(makeJob());

    // First save snapshot: status should be SUBMITTED (persisted before network call)
    expect(savedSnapshots[0].status).toBe(SubmissionStatus.SUBMITTED);
    expect(savedSnapshots[0].txHash).toBe(''); // hash not yet known

    // Second save snapshot: status should be CONFIRMED with real hash
    expect(savedSnapshots[1].status).toBe(SubmissionStatus.CONFIRMED);
    expect(savedSnapshots[1].txHash).toBe('real-tx-hash-abc');
    expect(savedSnapshots[1].result).toMatchObject({
      confirmed: true,
      nonce: 1,
      ledger: 12345,
    });
  });

  // ── multi-parameter mapping ───────────────────────────────────────────────

  it('calls submitReading with the full OracleReadingPayload derived from readingsSnapshot', async () => {
    const snapshot = {
      ph: 7.2,
      turbidity: 12.4,
      dissolvedOxygen: 6.8,
      flowRate: 1.834,
      nitrogen: 2.45,
      phosphorus: 0.125,
      temperature: 18.5,
    };
    findOneMock.mockResolvedValue(makeSubmission({ readingsSnapshot: snapshot, nonce: 5 }));
    getOracleNonceMock.mockResolvedValue(4);
    submitReadingMock.mockResolvedValue({ txHash: 'tx-hash', response: SUCCESS_RESPONSE });

    await processor.processSubmission(makeJob({ nonce: 5 }));

    expect(submitReadingMock).toHaveBeenCalledWith(
      'CONTRACT_ORACLE_ID',
      'proj-1',
      {
        ph: 7.2,
        turbidity: 12.4,
        dissolvedOxygen: 6.8,
        flowRate: 1.834,
        nitrogen: 2.45,
        phosphorus: 0.125,
        temperature: 18.5,
      },
      5,
    );
  });

  it('passes null for absent parameters rather than defaulting to 0', async () => {
    // Only pH is present; everything else should be null, not zero.
    findOneMock.mockResolvedValue(makeSubmission({ readingsSnapshot: { ph: 6.9 } }));
    submitReadingMock.mockResolvedValue({ txHash: 'tx-hash', response: SUCCESS_RESPONSE });

    await processor.processSubmission(makeJob());

    expect(submitReadingMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({
        ph: 6.9,
        turbidity: null,
        dissolvedOxygen: null,
        flowRate: null,
        nitrogen: null,
        phosphorus: null,
        temperature: null,
      }),
      expect.any(Number),
    );
  });

  it('maps snake_case snapshot fields to the structured payload', async () => {
    const snapshot = {
      ph: 7.0,
      dissolved_oxygen: 5.5,
      total_nitrogen_mgl: 3.0,
    };
    findOneMock.mockResolvedValue(makeSubmission({ readingsSnapshot: snapshot }));
    submitReadingMock.mockResolvedValue({ txHash: 'tx-hash', response: SUCCESS_RESPONSE });

    await processor.processSubmission(makeJob());

    const call = submitReadingMock.mock.calls[0];
    const payload = call[2];
    expect(payload.ph).toBe(7.0);
    expect(payload.dissolvedOxygen).toBe(5.5);
    expect(payload.nitrogen).toBe(3.0);
  });

  // ── empty snapshot must error, not send 0 ────────────────────────────────

  it('marks FAILED and throws when snapshot contains no recognisable parameters', async () => {
    findOneMock.mockResolvedValue(makeSubmission({ readingsSnapshot: {} }));

    await expect(processor.processSubmission(makeJob())).rejects.toThrow(
      /no recognisable numeric parameters/,
    );

    const failedSnapshot = savedSnapshots.find((s) => s.status === SubmissionStatus.FAILED);
    expect(failedSnapshot).toBeDefined();
    expect(failedSnapshot!.result).toMatchObject({
      error: expect.stringMatching(/no recognisable numeric parameters/),
    });
    expect(submitReadingMock).not.toHaveBeenCalled();
  });

  it('marks FAILED when all snapshot values are null', async () => {
    findOneMock.mockResolvedValue(
      makeSubmission({ readingsSnapshot: { ph: null, dissolvedOxygen: null } }),
    );

    await expect(processor.processSubmission(makeJob())).rejects.toThrow(
      /no recognisable numeric parameters/,
    );
    expect(submitReadingMock).not.toHaveBeenCalled();
  });

  // ── scoreReading penalty applies only to DO ───────────────────────────────

  it('applies the DO penalty only to dissolvedOxygen, leaving other fields unchanged', async () => {
    const snapshot = {
      ph: 7.2,
      turbidity: 5.0,
      dissolvedOxygen: 3.0, // below typical doThreshold of 5.0
      temperature: 20.0,
    };
    findOneMock.mockResolvedValue(makeSubmission({ readingsSnapshot: snapshot }));
    submitReadingMock.mockResolvedValue({ txHash: 'tx-hash', response: SUCCESS_RESPONSE });

    // Inject a config snapshot with doThreshold = 5.0 via job data
    const jobWithConfig = {
      data: {
        submissionId: 'sub-1',
        projectId: 'proj-1',
        oracleAddress: 'GABC123',
        nonce: 1,
        configSnapshot: {
          protocolFeeBps: 100,
          minOracleConfirmations: 3,
          phMin: null,
          phMax: null,
          doThreshold: 5.0,
          tempPenaltyDelta: null,
          weightVolumetric: 0.5,
          weightNitrogen: 0.3,
          weightPhosphorus: 0.2,
        },
      },
    } as never;

    await processor.processSubmission(jobWithConfig);

    const call = submitReadingMock.mock.calls[0];
    const payload = call[2];

    // DO should be penalised: 3.0 * 0.8 = 2.4
    expect(payload.dissolvedOxygen).toBeCloseTo(2.4, 3);
    // pH must be untouched
    expect(payload.ph).toBe(7.2);
    // turbidity must be untouched
    expect(payload.turbidity).toBe(5.0);
    // temperature must be untouched
    expect(payload.temperature).toBe(20.0);
  });

  it('does not penalise DO when it meets or exceeds the threshold', async () => {
    const snapshot = { dissolvedOxygen: 6.0 };
    findOneMock.mockResolvedValue(makeSubmission({ readingsSnapshot: snapshot }));
    submitReadingMock.mockResolvedValue({ txHash: 'tx-hash', response: SUCCESS_RESPONSE });

    const jobWithConfig = {
      data: {
        submissionId: 'sub-1',
        projectId: 'proj-1',
        oracleAddress: 'GABC123',
        nonce: 1,
        configSnapshot: {
          protocolFeeBps: 100,
          minOracleConfirmations: 3,
          phMin: null,
          phMax: null,
          doThreshold: 5.0,
          tempPenaltyDelta: null,
          weightVolumetric: 0.5,
          weightNitrogen: 0.3,
          weightPhosphorus: 0.2,
        },
      },
    } as never;

    await processor.processSubmission(jobWithConfig);

    const payload = submitReadingMock.mock.calls[0][2];
    expect(payload.dissolvedOxygen).toBe(6.0);
  });

  // ── SUBMITTED → FAILED ───────────────────────────────────────────────────

  it('transitions SUBMITTED → FAILED when submitReading throws', async () => {
    findOneMock.mockResolvedValue(makeSubmission());
    submitReadingMock.mockRejectedValue(new Error('Transaction timed out'));

    await expect(processor.processSubmission(makeJob())).rejects.toThrow('Transaction timed out');

    const submittedSnapshot = savedSnapshots.find((s) => s.status === SubmissionStatus.SUBMITTED);
    const failedSnapshot = savedSnapshots.find((s) => s.status === SubmissionStatus.FAILED);

    expect(submittedSnapshot).toBeDefined();
    expect(failedSnapshot).toBeDefined();
    expect(failedSnapshot!.result).toMatchObject({ error: 'Transaction timed out' });
  });

  it('does not set txHash on FAILED submission', async () => {
    findOneMock.mockResolvedValue(makeSubmission());
    submitReadingMock.mockRejectedValue(new Error('network error'));

    await expect(processor.processSubmission(makeJob())).rejects.toThrow();

    const failedSnapshot = savedSnapshots.find((s) => s.status === SubmissionStatus.FAILED)!;

    expect(failedSnapshot.txHash).toBe(''); // unchanged from initial empty string
  });

  // Nonce drift, re-sequencing, and idempotency
  describe('processing-time nonce drift handling', () => {
    it('marks as CONFIRMED directly if submission nonce equals on-chain nonce', async () => {
      findOneMock.mockResolvedValue(makeSubmission({ nonce: 5 }));
      getOracleNonceMock.mockResolvedValue(5);

      await processor.processSubmission(makeJob({ nonce: 5 }));

      expect(submitReadingMock).not.toHaveBeenCalled();
      expect(savedSnapshots).toHaveLength(1);
      expect(savedSnapshots[0].status).toBe(SubmissionStatus.CONFIRMED);
      expect(savedSnapshots[0].txHash).toBe('reconciled-on-chain');
    });

    it('fails cleanly if submission nonce is strictly less than on-chain nonce', async () => {
      findOneMock.mockResolvedValue(makeSubmission({ nonce: 4 }));
      getOracleNonceMock.mockResolvedValue(5);

      await processor.processSubmission(makeJob({ nonce: 4 }));

      expect(submitReadingMock).not.toHaveBeenCalled();
      expect(savedSnapshots).toHaveLength(1);
      expect(savedSnapshots[0].status).toBe(SubmissionStatus.FAILED);
      expect(savedSnapshots[0].result).toMatchObject({
        error: expect.stringContaining('Stale submission'),
      });
    });

    it('re-sequences to expected on-chain nonce if submission nonce is higher and no newer confirmed exists', async () => {
      findOneMock.mockResolvedValueOnce(makeSubmission({ nonce: 10 })).mockResolvedValueOnce(null);
      getOracleNonceMock.mockResolvedValue(5);
      submitReadingMock.mockResolvedValue({ txHash: 'tx-hash', response: SUCCESS_RESPONSE });

      await processor.processSubmission(makeJob({ nonce: 10 }));

      expect(submitReadingMock).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.any(Object),
        6,
      );
      expect(savedSnapshots).toHaveLength(3);
      expect(savedSnapshots[0].nonce).toBe(6);
      expect(savedSnapshots[2].status).toBe(SubmissionStatus.CONFIRMED);
    });

    it('fails cleanly if submission nonce is higher but a newer confirmed submission already exists', async () => {
      const oldSubmission = makeSubmission({ nonce: 10, createdAt: new Date('2026-08-20') });
      const newSubmission = makeSubmission({
        nonce: 8,
        createdAt: new Date('2026-08-21'),
        status: SubmissionStatus.CONFIRMED,
      });

      findOneMock.mockResolvedValue(oldSubmission);
      getOracleNonceMock.mockResolvedValue(5);

      const originalFindOne = findOneMock;
      findOneMock = jest.fn().mockImplementation((options) => {
        if (options?.where?.id) {
          return Promise.resolve(oldSubmission);
        }
        return Promise.resolve(newSubmission);
      });
      processor['submissionRepo'].findOne = findOneMock;

      await processor.processSubmission(makeJob({ nonce: 10 }));

      expect(submitReadingMock).not.toHaveBeenCalled();
      expect(savedSnapshots).toHaveLength(1);
      expect(savedSnapshots[0].status).toBe(SubmissionStatus.FAILED);
      expect(savedSnapshots[0].result).toMatchObject({
        error: expect.stringContaining('newer submission sub-1 already confirmed'),
      });

      findOneMock = originalFindOne;
    });

    it('does not wedge the queue when simulating an advanced on-chain nonce + a retried stale submission', async () => {
      // Stale submission (nonce 4), but on-chain nonce is already advanced to 5
      findOneMock.mockResolvedValue(makeSubmission({ nonce: 4 }));
      getOracleNonceMock.mockResolvedValue(5);

      // Processing must resolve successfully (not throw) so the job completes rather than wedging the queue
      await expect(processor.processSubmission(makeJob({ nonce: 4 }))).resolves.toBeUndefined();

      expect(submitReadingMock).not.toHaveBeenCalled();
      expect(savedSnapshots).toHaveLength(1);
      expect(savedSnapshots[0].status).toBe(SubmissionStatus.FAILED);
      expect(savedSnapshots[0].result).toMatchObject({
        error: expect.stringContaining('Stale submission'),
      });
    });
  });
});
