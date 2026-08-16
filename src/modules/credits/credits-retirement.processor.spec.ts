import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { SorobanRpc } from '@stellar/stellar-sdk';
import { CreditsRetirementProcessor } from './credits-retirement.processor';
import { Retirement } from './entities/retirement.entity';
import { StellarService } from '../stellar/stellar.service';
import { NotificationsService } from '../notifications/notifications.service';

function makeRetirement(overrides: Partial<Retirement> = {}): Retirement {
  return {
    id: 'ret-1',
    userId: 'user-1',
    projectId: 'proj-1',
    amount: 100,
    purpose: 'carbon offset',
    metadataUri: 'https://example.com/cert',
    txHash: '',
    certificateIpfsUri: null,
    retiredAt: new Date(),
    createdAt: new Date(),
    user: undefined as never,
    project: undefined as never,
    ...overrides,
  };
}

function makeJob(
  data: Partial<{
    retirementId: string;
    userId: string;
    projectId: string;
    tokenId: string;
    amount: number;
    purpose: string;
    metadataUri: string;
  }> = {},
) {
  return {
    data: {
      retirementId: 'ret-1',
      userId: 'user-1',
      projectId: 'proj-1',
      tokenId: 'CONTRACT_TOKEN_ID',
      amount: 100,
      purpose: 'carbon offset',
      metadataUri: 'https://example.com/cert',
      ...data,
    },
  } as never;
}

const SUCCESS_RESPONSE = {
  status: SorobanRpc.Api.GetTransactionStatus.SUCCESS,
} as SorobanRpc.Api.GetSuccessfulTransactionResponse;

describe('CreditsRetirementProcessor', () => {
  let processor: CreditsRetirementProcessor;

  let savedSnapshots: Retirement[];
  let findOneMock: jest.Mock;
  let saveMock: jest.Mock;
  let retireCreditsWithHashMock: jest.Mock;
  let notifyCreditRetiredMock: jest.Mock;

  beforeEach(async () => {
    savedSnapshots = [];
    findOneMock = jest.fn();
    saveMock = jest.fn().mockImplementation((r: Retirement) => {
      savedSnapshots.push({ ...r });
      return Promise.resolve({ ...r });
    });
    retireCreditsWithHashMock = jest.fn();
    notifyCreditRetiredMock = jest.fn();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CreditsRetirementProcessor,
        {
          provide: getRepositoryToken(Retirement),
          useValue: { findOne: findOneMock, save: saveMock },
        },
        {
          provide: StellarService,
          useValue: { retireCreditsWithHash: retireCreditsWithHashMock },
        },
        {
          provide: NotificationsService,
          useValue: { notifyCreditRetired: notifyCreditRetiredMock },
        },
      ],
    }).compile();

    processor = module.get<CreditsRetirementProcessor>(CreditsRetirementProcessor);
  });

  it('skips gracefully when retirement row is not found', async () => {
    findOneMock.mockResolvedValue(null);

    await expect(processor.processRetirement(makeJob())).resolves.toBeUndefined();
    expect(retireCreditsWithHashMock).not.toHaveBeenCalled();
    expect(notifyCreditRetiredMock).not.toHaveBeenCalled();
  });

  it('skips without re-submitting when already has a real txHash', async () => {
    findOneMock.mockResolvedValue(makeRetirement({ txHash: 'real-tx-hash' }));

    await expect(processor.processRetirement(makeJob())).resolves.toBeUndefined();
    expect(retireCreditsWithHashMock).not.toHaveBeenCalled();
    expect(notifyCreditRetiredMock).not.toHaveBeenCalled();
  });

  it('transitions pending → confirmed and persists real txHash', async () => {
    findOneMock.mockResolvedValue(makeRetirement({ txHash: '' }));
    retireCreditsWithHashMock.mockResolvedValue({
      txHash: 'real-tx-hash-abc',
      response: SUCCESS_RESPONSE,
    });

    await processor.processRetirement(makeJob());

    // First save: txHash = `tx-pending-...` (before network call)
    expect(savedSnapshots[0].txHash).toMatch(/^tx-pending-/);

    // Second save: txHash = real hash
    expect(savedSnapshots[1].txHash).toBe('real-tx-hash-abc');
    expect(savedSnapshots[1].retiredAt).toBeInstanceOf(Date);

    expect(notifyCreditRetiredMock).toHaveBeenCalledWith('user-1', 'proj-1', 100);
  });

  it('calls retireCreditsWithHash with correct arguments', async () => {
    findOneMock.mockResolvedValue(makeRetirement({ txHash: '' }));
    retireCreditsWithHashMock.mockResolvedValue({
      txHash: 'tx-hash',
      response: SUCCESS_RESPONSE,
    });

    await processor.processRetirement(
      makeJob({
        tokenId: 'TOKEN_XYZ',
        amount: 50,
        purpose: 'reforestation',
        metadataUri: 'https://example.com/cert-2',
      }),
    );

    expect(retireCreditsWithHashMock).toHaveBeenCalledWith(
      'TOKEN_XYZ',
      expect.any(Object),
      'reforestation',
      'https://example.com/cert-2',
    );

    expect(notifyCreditRetiredMock).toHaveBeenCalledWith('user-1', 'proj-1', 50);
  });

  it('clears txHash and throws when retireCreditsWithHash fails', async () => {
    findOneMock.mockResolvedValue(makeRetirement({ txHash: '' }));
    retireCreditsWithHashMock.mockRejectedValue(new Error('Stellar RPC timeout'));

    await expect(processor.processRetirement(makeJob())).rejects.toThrow('Stellar RPC timeout');

    // First save set tx-pending, second save clears it to ''
    const cleared = savedSnapshots.find((s) => s.txHash === '');
    expect(cleared).toBeDefined();
    expect(notifyCreditRetiredMock).not.toHaveBeenCalled();
  });

  it('fails gracefully instead of calling the contract with an undefined tokenId', async () => {
    findOneMock.mockResolvedValue(makeRetirement({ txHash: '' }));

    await expect(
      processor.processRetirement(makeJob({ tokenId: undefined })),
    ).rejects.toThrow(/tokenId/);

    // Never reaches the Stellar SDK with an undefined contract id.
    expect(retireCreditsWithHashMock).not.toHaveBeenCalled();
    expect(notifyCreditRetiredMock).not.toHaveBeenCalled();
  });

  it('throws on non-SUCCESS terminal status', async () => {
    findOneMock.mockResolvedValue(makeRetirement({ txHash: '' }));
    retireCreditsWithHashMock.mockResolvedValue({
      txHash: 'tx-hash',
      response: { status: 'FAILED' } as SorobanRpc.Api.GetFailedTransactionResponse,
    });

    await expect(processor.processRetirement(makeJob())).rejects.toThrow(
      'Unexpected terminal status',
    );

    // Should clear txHash on failure
    const cleared = savedSnapshots.find((s) => s.txHash === '');
    expect(cleared).toBeDefined();
    expect(notifyCreditRetiredMock).not.toHaveBeenCalled();
  });
});
