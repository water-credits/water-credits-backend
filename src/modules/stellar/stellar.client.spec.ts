import { ConfigService } from '@nestjs/config';
import { Account, Keypair, Networks, Operation, TransactionBuilder } from '@stellar/stellar-sdk';
import { StellarClient, STELLAR_BACKEND_SECRET_PLACEHOLDER } from './stellar.client';

describe('StellarClient simulation account', () => {
  const simulationSecret = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 1)).secret();

  function createClient(
    opts: {
      simulationSecretValue?: string;
      backendSecret?: string;
      requireSigningKey?: boolean;
    } = {},
  ): StellarClient {
    const values: Record<string, string | boolean> = {
      'stellar.rpcUrl': 'https://soroban-testnet.stellar.org',
      'stellar.backendSecret': opts.backendSecret ?? '',
      'stellar.simulationSecret': opts.simulationSecretValue ?? '',
      'stellar.requireSigningKey': opts.requireSigningKey ?? false,
    };
    const configService = {
      get: jest.fn((key: string, fallback?: unknown) => (key in values ? values[key] : fallback)),
    } as unknown as ConfigService;

    return new StellarClient(configService);
  }

  function buildTransaction(source: string) {
    return new TransactionBuilder(new Account(source, '0'), {
      fee: '100',
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(Operation.manageData({ name: 'simulation-test', value: '1' }))
      .setTimeout(0)
      .build();
  }

  it('reuses one cached simulation keypair', () => {
    const client = createClient();

    expect(client.getSimulationKeypair()).toBe(client.getSimulationKeypair());
    expect(client.getSimulationKeypair().publicKey()).toBe(
      Keypair.fromRawEd25519Seed(Buffer.alloc(32)).publicKey(),
    );
  });

  it('accepts an injectable simulation secret', () => {
    const client = createClient({ simulationSecretValue: simulationSecret });

    expect(client.getSimulationKeypair().secret()).toBe(simulationSecret);
  });

  it('blocks simulation transactions in sendTx before contacting the RPC server', async () => {
    const client = createClient();
    const transaction = buildTransaction(client.getSimulationKeypair().publicKey());
    const sendTransaction = jest.spyOn(client.getServer(), 'sendTransaction');

    await expect(client.sendTx(transaction)).rejects.toThrow(
      'Simulation transactions must not be submitted',
    );
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  it('blocks simulation transactions in sendTxWithHash before contacting the RPC server', async () => {
    const client = createClient();
    const transaction = buildTransaction(client.getSimulationKeypair().publicKey());
    const sendTransaction = jest.spyOn(client.getServer(), 'sendTransaction');

    await expect(client.sendTxWithHash(transaction)).rejects.toThrow(
      'Simulation transactions must not be submitted',
    );
    expect(sendTransaction).not.toHaveBeenCalled();
  });
});

describe('StellarClient signing readiness', () => {
  function createClient(
    opts: {
      backendSecret?: string;
      requireSigningKey?: boolean;
    } = {},
  ): StellarClient {
    const values: Record<string, string | boolean> = {
      'stellar.rpcUrl': 'https://soroban-testnet.stellar.org',
      'stellar.backendSecret': opts.backendSecret ?? '',
      'stellar.simulationSecret': '',
      'stellar.requireSigningKey': opts.requireSigningKey ?? false,
    };
    const configService = {
      get: jest.fn((key: string, fallback?: unknown) => (key in values ? values[key] : fallback)),
    } as unknown as ConfigService;

    return new StellarClient(configService);
  }

  it('reports signing_ready false when secret is empty', () => {
    const client = createClient({ backendSecret: '' });
    expect(client.isSigningReady()).toBe(false);
  });

  it('reports signing_ready false when secret is the placeholder', () => {
    const client = createClient({ backendSecret: STELLAR_BACKEND_SECRET_PLACEHOLDER });
    expect(client.isSigningReady()).toBe(false);
  });

  it('reports signing_ready false when secret is invalid', () => {
    const client = createClient({ backendSecret: 'not-a-stellar-secret' });
    expect(client.isSigningReady()).toBe(false);
  });

  it('reports signing_ready true when secret is a valid S-key', () => {
    const secret = Keypair.random().secret();
    const client = createClient({ backendSecret: secret });
    expect(client.isSigningReady()).toBe(true);
    expect(client.getKeypair().secret()).toBe(secret);
  });

  it('throws on boot when requireSigningKey is true and secret is unusable', () => {
    expect(() => createClient({ backendSecret: '', requireSigningKey: true })).toThrow(
      /STELLAR_REQUIRE_SIGNING_KEY=true/,
    );
  });

  it('does not throw when requireSigningKey is true and secret is valid', () => {
    const secret = Keypair.random().secret();
    expect(() => createClient({ backendSecret: secret, requireSigningKey: true })).not.toThrow();
  });
});
