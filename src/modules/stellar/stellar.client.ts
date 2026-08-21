import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SorobanRpc, Keypair, Transaction, xdr } from '@stellar/stellar-sdk';

const DEFAULT_SIMULATION_SEED = Buffer.alloc(32);
/** Placeholder / empty secrets are treated as "not configured". */
export const STELLAR_BACKEND_SECRET_PLACEHOLDER = 'SDN...TODO';

export function isUsableBackendSecret(secret: string | undefined | null): boolean {
  if (!secret) {
    return false;
  }
  const trimmed = secret.trim();
  if (!trimmed || trimmed === STELLAR_BACKEND_SECRET_PLACEHOLDER) {
    return false;
  }
  try {
    Keypair.fromSecret(trimmed);
    return true;
  } catch {
    return false;
  }
}

@Injectable()
export class StellarClient {
  private readonly logger = new Logger(StellarClient.name);
  private server: SorobanRpc.Server;
  private keypair: Keypair;
  private readonly simulationKeypair: Keypair;
  private readonly signingReady: boolean;

  constructor(private configService: ConfigService) {
    const rpcUrl = this.configService.get<string>('stellar.rpcUrl')!;
    const backendSecret = this.configService.get<string>('stellar.backendSecret');
    const simulationSecret = this.configService.get<string>('stellar.simulationSecret');
    const requireSigningKey = this.configService.get<boolean>('stellar.requireSigningKey', false);

    this.server = new SorobanRpc.Server(rpcUrl);
    this.simulationKeypair = simulationSecret
      ? Keypair.fromSecret(simulationSecret)
      : Keypair.fromRawEd25519Seed(DEFAULT_SIMULATION_SEED);

    this.signingReady = isUsableBackendSecret(backendSecret);

    if (this.signingReady) {
      this.keypair = Keypair.fromSecret(backendSecret!.trim());
    } else {
      this.logger.warn(
        'STELLAR_BACKEND_SECRET not properly configured — on-chain writes will fail. ' +
          'Set a valid secret, or set STELLAR_REQUIRE_SIGNING_KEY=true to fail fast.',
      );

      if (requireSigningKey) {
        throw new Error(
          'STELLAR_BACKEND_SECRET is missing, placeholder, or invalid, and ' +
            'STELLAR_REQUIRE_SIGNING_KEY=true. Refusing to start.',
        );
      }

      // Dev/test fallback only — transactions signed with this key will fail on-chain.
      this.keypair = Keypair.random();
    }
  }

  getServer(): SorobanRpc.Server {
    return this.server;
  }

  getKeypair(): Keypair {
    return this.keypair;
  }

  getSimulationKeypair(): Keypair {
    return this.simulationKeypair;
  }

  isSigningReady(): boolean {
    return this.signingReady;
  }

  private assertSendable(tx: Transaction): void {
    if (tx.source === this.simulationKeypair.publicKey()) {
      throw new Error('Simulation transactions must not be submitted');
    }
  }

  async simulateTx(tx: Transaction): Promise<SorobanRpc.Api.SimulateTransactionResponse> {
    return this.server.simulateTransaction(tx);
  }

  async prepareTx(tx: Transaction): Promise<Transaction> {
    return this.server.prepareTransaction(tx);
  }

  async sendTx(tx: Transaction): Promise<SorobanRpc.Api.GetTransactionResponse> {
    this.assertSendable(tx);
    const response = await this.server.sendTransaction(tx);
    if (response.status === 'ERROR') {
      throw new Error(`Transaction failed: ${JSON.stringify(response)}`);
    }

    // Poll for status
    let statusResponse = await this.server.getTransaction(response.hash);
    let attempts = 0;
    const maxAttempts = 30;

    while (attempts < maxAttempts) {
      if (statusResponse.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
        return statusResponse;
      }

      if (statusResponse.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
        throw new Error(`Transaction failed: ${statusResponse.resultMetaXdr}`);
      }

      // If NOT_FOUND or any other status (like PENDING if applicable), wait and poll
      await new Promise((resolve) => setTimeout(resolve, 2000));
      statusResponse = await this.server.getTransaction(response.hash);
      attempts++;
    }

    throw new Error(`Transaction polling timed out for ${response.hash}`);
  }

  /**
   * Same as sendTx() but also returns the transaction hash from the initial
   * sendTransaction response so callers that need to persist the hash (e.g.
   * the oracle processor) can do so without a second RPC call.
   */
  async sendTxWithHash(
    tx: Transaction,
  ): Promise<{ txHash: string; response: SorobanRpc.Api.GetTransactionResponse }> {
    this.assertSendable(tx);
    const sendResponse = await this.server.sendTransaction(tx);
    if (sendResponse.status === 'ERROR') {
      throw new Error(`Transaction failed: ${JSON.stringify(sendResponse)}`);
    }

    const txHash = sendResponse.hash;
    let statusResponse = await this.server.getTransaction(txHash);
    let attempts = 0;
    const maxAttempts = 30;

    while (attempts < maxAttempts) {
      if (statusResponse.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
        return { txHash, response: statusResponse };
      }

      if (statusResponse.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
        throw new Error(`Transaction failed: ${statusResponse.resultMetaXdr}`);
      }

      await new Promise((resolve) => setTimeout(resolve, 2000));
      statusResponse = await this.server.getTransaction(txHash);
      attempts++;
    }

    throw new Error(`Transaction polling timed out for ${txHash}`);
  }

  async getLedgerEntries(
    ...keys: xdr.LedgerKey[]
  ): Promise<SorobanRpc.Api.GetLedgerEntriesResponse> {
    return this.server.getLedgerEntries(...keys);
  }
}
