import { ConfigService } from '@nestjs/config';
import { SorobanRpc, nativeToScVal, scValToNative } from '@stellar/stellar-sdk';
import { StellarService } from './stellar.service';
import { StellarClient } from './stellar.client';

describe('StellarService.createProposal', () => {
  let service: StellarService;
  let invokeSpy: jest.SpyInstance;

  function makeConfigService(): ConfigService {
    return {
      get: jest.fn((key: string) => {
        if (key === 'stellar.horizonUrl') {
          return 'https://horizon-testnet.stellar.org';
        }
        return undefined;
      }),
    } as unknown as ConfigService;
  }

  beforeEach(() => {
    service = new StellarService(makeConfigService(), {} as StellarClient);
    const proto = StellarService.prototype as unknown as {
      invokeContract: (...args: unknown[]) => Promise<unknown>;
    };
    invokeSpy = jest.spyOn(proto, 'invokeContract');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('decodes the u32 proposal id from the propose() return value', async () => {
    invokeSpy.mockResolvedValue({
      status: SorobanRpc.Api.GetTransactionStatus.SUCCESS,
      returnValue: nativeToScVal(42, { type: 'u32' }),
    } as SorobanRpc.Api.GetSuccessfulTransactionResponse);

    const proposalId = await service.createProposal('CGOVERNANCE123', 'Title', 'Desc', {
      actionType: 'update_fee',
    });

    expect(invokeSpy).toHaveBeenCalledTimes(1);
    expect(invokeSpy.mock.calls[0][0]).toBe('CGOVERNANCE123');
    expect(invokeSpy.mock.calls[0][1]).toBe('propose');

    const args = invokeSpy.mock.calls[0][2] as unknown[];
    expect(args).toHaveLength(3);
    expect(scValToNative(args[0] as never)).toBe('Title');
    expect(scValToNative(args[1] as never)).toBe('Desc');
    expect(scValToNative(args[2] as never)).toBe(JSON.stringify({ actionType: 'update_fee' }));

    expect(proposalId).toBe(42);
  });

  it('throws when the propose() transaction does not return a value', async () => {
    invokeSpy.mockResolvedValue({
      status: SorobanRpc.Api.GetTransactionStatus.SUCCESS,
    } as SorobanRpc.Api.GetSuccessfulTransactionResponse);

    await expect(service.createProposal('CGOVERNANCE123', 'T', 'D', {})).rejects.toThrow(
      'Governance propose() did not return a proposal id',
    );
  });

  it('throws when the propose() return value is not a number', async () => {
    invokeSpy.mockResolvedValue({
      status: SorobanRpc.Api.GetTransactionStatus.SUCCESS,
      returnValue: nativeToScVal('not-a-number', { type: 'string' }),
    } as SorobanRpc.Api.GetSuccessfulTransactionResponse);

    await expect(service.createProposal('CGOVERNANCE123', 'T', 'D', {})).rejects.toThrow(
      'returned an unexpected value',
    );
  });
});
