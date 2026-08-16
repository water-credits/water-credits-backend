import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { SorobanRpc } from '@stellar/stellar-sdk';
import { OracleProcessor } from './oracle-processor';
import { OracleSubmission, SubmissionStatus } from './entities/oracle-submission.entity';
import { GovernanceConfig } from '../governance/entities/governance-config.entity';
import { StellarService } from '../stellar/stellar.service';
import { CreditScoringService } from './credit-scoring.service';
import { GovernanceConfig } from '../governance/entities/governance-config.entity';
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
    readingsSnapshot: { dissolvedOxygen: 6.8, ph: 7.2 },
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
// Tests
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
  let configGetMock: jest.Mock;

  beforeEach(async () => {
    savedSnapshots = [];
    findOneMock = jest.fn();
    saveMock = jest.fn().mockImplementation((s: OracleSubmission) => {
      savedSnapshots.push({ ...s });
      return Promise.resolve({ ...s });
    });
    submitReadingMock = jest.fn();
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
        { provide: StellarService, useValue: { submitReading: submitReadingMock } },
        { provide: ConfigService, useValue: { get: configGetMock } },
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
    findOneMock.mockResolvedValue(makeSubmission({ status: SubmissionStatus.FAILED }));
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

  it('calls submitReading with correct arguments derived from readingsSnapshot', async () => {
    findOneMock.mockResolvedValue(makeSubmission({ readingsSnapshot: { dissolvedOxygen: 7.5 } }));
    submitReadingMock.mockResolvedValue({ txHash: 'tx-hash', response: SUCCESS_RESPONSE });

    await processor.processSubmission(makeJob({ nonce: 5 }));

    expect(submitReadingMock).toHaveBeenCalledWith(
      'CONTRACT_ORACLE_ID',
      'proj-1',
      { value: 7.5 },
      5,
    );
  });

  it('falls back to ph when dissolvedOxygen is absent from snapshot', async () => {
    findOneMock.mockResolvedValue(makeSubmission({ readingsSnapshot: { ph: 6.9 } }));
    submitReadingMock.mockResolvedValue({ txHash: 'tx-hash', response: SUCCESS_RESPONSE });

    await processor.processSubmission(makeJob());

    expect(submitReadingMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      { value: 6.9 },
      expect.any(Number),
    );
  });

  it('uses value 0 when snapshot has no recognised keys', async () => {
    findOneMock.mockResolvedValue(makeSubmission({ readingsSnapshot: { temperature: 20 } }));
    submitReadingMock.mockResolvedValue({ txHash: 'tx-hash', response: SUCCESS_RESPONSE });

    await processor.processSubmission(makeJob());

    expect(submitReadingMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      { value: 0 },
      expect.any(Number),
    );
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
});
