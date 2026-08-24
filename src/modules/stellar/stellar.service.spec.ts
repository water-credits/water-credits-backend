import { ConfigService } from '@nestjs/config';
import { SorobanRpc, nativeToScVal, scValToNative, xdr, StrKey } from '@stellar/stellar-sdk';
import { StellarService, OracleReadingPayload } from './stellar.service';
import { StellarClient } from './stellar.client';
import { randomBytes } from 'crypto';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generates a valid 56-character Stellar contract address for use in tests. */
function randomContractId(): string {
  return StrKey.encodeContract(randomBytes(32));
}

function randomAccountId(): string {
  return StrKey.encodeEd25519PublicKey(randomBytes(32));
}

function makeConfigService(): ConfigService {
  return {
    get: jest.fn((key: string) => {
      if (key === 'stellar.horizonUrl') return 'https://horizon-testnet.stellar.org';
      if (key === 'stellar.passphrase') return 'Test SDF Network ; September 2015';
      return undefined;
    }),
  } as unknown as ConfigService;
}

// ---------------------------------------------------------------------------
// createProposal tests
// ---------------------------------------------------------------------------

describe('StellarService.createProposal', () => {
  let service: StellarService;
  let invokeSpy: jest.SpyInstance;

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

// ---------------------------------------------------------------------------
// submitReading tests — structured multi-parameter payload
// ---------------------------------------------------------------------------

describe('StellarService.submitReading', () => {
  let service: StellarService;
  let oracleContractId: string;

  // We stub the three low-level client calls that submitReading depends on.
  let mockGetKeypair: jest.Mock;
  let mockGetNetwork: jest.Mock;
  let mockBuildAccount: jest.Mock;
  let mockPrepareTx: jest.Mock;
  let mockSendTxWithHash: jest.Mock;

  // Capture the ScVal[] arguments passed to contract.call('submit_reading', ...)
  let capturedArgs: xdr.ScVal[];

  beforeEach(() => {
    oracleContractId = randomContractId();

    const { Keypair, Account } = jest.requireActual<typeof import('@stellar/stellar-sdk')>(
      '@stellar/stellar-sdk',
    );

    // A deterministic throw-away keypair for tests.
    const keypair = Keypair.random();
    const fakeAccount = new Account(keypair.publicKey(), '100');

    mockGetKeypair = jest.fn().mockReturnValue(keypair);
    mockGetNetwork = jest.fn().mockResolvedValue({
      passphrase: 'Test SDF Network ; September 2015',
    });
    mockBuildAccount = jest.fn().mockResolvedValue(fakeAccount);
    mockPrepareTx = jest.fn().mockImplementation((tx) => Promise.resolve(tx));
    mockSendTxWithHash = jest.fn().mockResolvedValue({
      txHash: 'mock-tx-hash',
      response: {
        status: SorobanRpc.Api.GetTransactionStatus.SUCCESS,
        ledger: 999,
      },
    });

    const mockClient = {
      getKeypair: mockGetKeypair,
      prepareTx: mockPrepareTx,
      sendTxWithHash: mockSendTxWithHash,
    } as unknown as StellarClient;

    service = new StellarService(makeConfigService(), mockClient);

    // Spy on the private buildAccount method (used internally).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    jest.spyOn(service as any, 'buildAccount').mockImplementation(mockBuildAccount);

    // Intercept getNetwork so we don't need live RPC.
    jest.spyOn(service, 'getNetwork').mockImplementation(mockGetNetwork);

    // Intercept prepareTx at the client level to capture transaction ops.
    mockPrepareTx.mockImplementation((tx) => {
      // Extract the ScVal arguments passed to the first operation.
      const body = tx.operations[0].func._value;
      // body is a ScContractCallBody; _value._attributes.args is the array of ScVals
      capturedArgs = body._attributes.args as xdr.ScVal[];
      return Promise.resolve(tx);
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('passes projectId as the first argument (string)', async () => {
    const payload: OracleReadingPayload = {
      ph: 7.2,
      turbidity: null,
      dissolvedOxygen: 6.8,
      flowRate: null,
      nitrogen: null,
      phosphorus: null,
      temperature: null,
    };

    await service.submitReading(oracleContractId, 'proj-abc', payload, 5);

    // args[0] = project_id (string)
    expect(scValToNative(capturedArgs[0])).toBe('proj-abc');
  });

  it('encodes a numeric field as i128 scaled by 1000', async () => {
    const payload: OracleReadingPayload = {
      ph: 7.2,
      turbidity: null,
      dissolvedOxygen: null,
      flowRate: null,
      nitrogen: null,
      phosphorus: null,
      temperature: null,
    };

    await service.submitReading(oracleContractId, 'proj-abc', payload, 1);

    // args[1] = ph → 7.2 * 1000 = 7200 as i128
    expect(scValToNative(capturedArgs[1])).toBe(7200n);
  });

  it('encodes a null field as ScVoid (Option::None)', async () => {
    const payload: OracleReadingPayload = {
      ph: null,
      turbidity: null,
      dissolvedOxygen: 6.8,
      flowRate: null,
      nitrogen: null,
      phosphorus: null,
      temperature: null,
    };

    await service.submitReading(oracleContractId, 'proj-abc', payload, 1);

    // args[1] = ph → null → scvVoid
    expect(capturedArgs[1].switch().name).toBe('scvVoid');
    // args[3] = dissolvedOxygen → 6.8 * 1000 = 6800
    expect(scValToNative(capturedArgs[3])).toBe(6800n);
  });

  it('encodes all seven parameters in the correct positional order', async () => {
    const payload: OracleReadingPayload = {
      ph: 7.2,          // pos 1 → 7200
      turbidity: 12.4,  // pos 2 → 12400
      dissolvedOxygen: 6.8, // pos 3 → 6800
      flowRate: 1.834,  // pos 4 → 1834
      nitrogen: 2.45,   // pos 5 → 2450
      phosphorus: 0.125,// pos 6 → 125
      temperature: 18.5,// pos 7 → 18500
    };

    await service.submitReading(oracleContractId, 'proj-abc', payload, 42);

    // args[0] = projectId
    expect(scValToNative(capturedArgs[0])).toBe('proj-abc');
    // args[1..7] = the seven parameters
    expect(scValToNative(capturedArgs[1])).toBe(7200n);  // ph
    expect(scValToNative(capturedArgs[2])).toBe(12400n); // turbidity
    expect(scValToNative(capturedArgs[3])).toBe(6800n);  // dissolvedOxygen
    expect(scValToNative(capturedArgs[4])).toBe(1834n);  // flowRate
    expect(scValToNative(capturedArgs[5])).toBe(2450n);  // nitrogen
    expect(scValToNative(capturedArgs[6])).toBe(125n);   // phosphorus
    expect(scValToNative(capturedArgs[7])).toBe(18500n); // temperature
    // args[8] = nonce (u32)
    expect(scValToNative(capturedArgs[8])).toBe(42);
  });

  it('encodes a full null payload (all fields null) with ScVoid for each parameter', async () => {
    // NOTE: mapSnapshotToPayload() guards against this before reaching
    // submitReading(), but submitReading() itself must handle it gracefully
    // (e.g. when called directly in tests or from future code paths).
    const payload: OracleReadingPayload = {
      ph: null,
      turbidity: null,
      dissolvedOxygen: null,
      flowRate: null,
      nitrogen: null,
      phosphorus: null,
      temperature: null,
    };

    await service.submitReading(oracleContractId, 'proj-abc', payload, 0);

    // All 7 parameter args should be ScVoid.
    for (let i = 1; i <= 7; i++) {
      expect(capturedArgs[i].switch().name).toBe('scvVoid');
    }
  });

  it('returns the txHash from sendTxWithHash', async () => {
    const payload: OracleReadingPayload = {
      ph: 7.0,
      turbidity: null,
      dissolvedOxygen: null,
      flowRate: null,
      nitrogen: null,
      phosphorus: null,
      temperature: null,
    };

    const result = await service.submitReading(oracleContractId, 'proj-abc', payload, 1);
    expect(result.txHash).toBe('mock-tx-hash');
  });
});


// ---------------------------------------------------------------------------
// batch ledger read tests
// ---------------------------------------------------------------------------

describe('StellarService batch ledger reads', () => {
  let service: StellarService;
  let getLedgerEntries: jest.Mock;

  const ledgerEntry = (key: xdr.LedgerKey, value: bigint) => ({
    key,
    val: {
      contractData: () => ({
        val: () => nativeToScVal(value, { type: 'i128' }),
      }),
    },
  });

  beforeEach(() => {
    getLedgerEntries = jest.fn();
    service = new StellarService(
      makeConfigService(),
      { getLedgerEntries } as unknown as StellarClient,
    );
  });

  it('reads all token totals in one RPC call and defaults missing entries to zero', async () => {
    getLedgerEntries.mockImplementation(async (...keys: xdr.LedgerKey[]) => ({
      entries: [ledgerEntry(keys[0], 1000n), ledgerEntry(keys[1], 200n), ledgerEntry(keys[2], 3000n)],
      latestLedger: 1,
    }));

    const result = await service.batchGetTokenStats([
      randomContractId(),
      randomContractId(),
    ]);

    expect(getLedgerEntries).toHaveBeenCalledTimes(1);
    expect(getLedgerEntries.mock.calls[0]).toHaveLength(4);
    expect(result.size).toBe(2);
    const firstStats = [...result.values()][0];
    expect(firstStats.totalSupply.toNumber()).toBe(1000);
    expect(firstStats.totalRetired.toNumber()).toBe(200);
    expect([...result.values()][1].totalSupply.toNumber()).toBe(3000);
    expect([...result.values()][1].totalRetired.toNumber()).toBe(0);

    const firstKey = getLedgerEntries.mock.calls[0][0] as xdr.LedgerKey;
    expect(firstKey.contractData().key().sym()).toBe('TotalSupply');
  });

  it('reads a project balance and totals in one RPC call', async () => {
    getLedgerEntries.mockImplementation(async (...keys: xdr.LedgerKey[]) => ({
      entries: [ledgerEntry(keys[0], 50n), ledgerEntry(keys[1], 1000n), ledgerEntry(keys[2], 200n)],
      latestLedger: 1,
    }));

    const tokenId = randomContractId();
    const wallet = randomAccountId();
    const result = await service.getTokenCreditDetails(tokenId, wallet);

    expect(getLedgerEntries).toHaveBeenCalledTimes(1);
    expect(getLedgerEntries.mock.calls[0]).toHaveLength(3);
    expect(result.balance?.toNumber()).toBe(50);
    expect(result.totalSupply.toNumber()).toBe(1000);
    expect(result.totalRetired.toNumber()).toBe(200);

    const balanceKey = getLedgerEntries.mock.calls[0][0] as xdr.LedgerKey;
    const balanceParts = balanceKey.contractData().key().vec();
    expect(balanceParts?.[0]?.sym()).toBe('Balance');
  });
});
