import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StellarClient } from './stellar.client';
import {
  Account,
  Keypair,
  SorobanRpc,
  TransactionBuilder,
  Horizon,
  Contract,
  xdr,
  nativeToScVal,
  scValToNative,
  Address,
} from '@stellar/stellar-sdk';
import { verifyStellarSignature } from '../modules/auth/stellar-auth.utils';
import { BigNumber } from 'bignumber.js';

@Injectable()
export class StellarService {
  private readonly logger = new Logger(StellarService.name);
  private horizon: Horizon.Server;

  constructor(
    private readonly configService: ConfigService,
    private readonly stellarClient: StellarClient,
  ) {
    const horizonUrl = this.configService.get<string>('stellar.horizonUrl')!;
    this.horizon = new Horizon.Server(horizonUrl);
  }

  // ── Authentication ──
  async generateChallenge(_wallet: string): Promise<string> {
    return `Login to Water Credits: ${Date.now()}`;
  }

  async verifySignature(wallet: string, signature: string, challenge: string): Promise<boolean> {
    try {
      return verifyStellarSignature(wallet, signature, challenge);
    } catch (error) {
      this.logger.error(`Signature verification failed: ${(error as Error).message}`);
      return false;
    }
  }

  // ── Network ──
  async getAccount(address: string): Promise<Horizon.AccountResponse> {
    return this.horizon.loadAccount(address);
  }

  private async buildAccount(keypair: Keypair): Promise<Horizon.AccountResponse> {
    return this.getAccount(keypair.publicKey());
  }

  async getNetwork() {
    return {
      passphrase: this.configService.get<string>('stellar.passphrase'),
      rpcUrl: this.configService.get<string>('stellar.rpcUrl'),
    };
  }

  // ── Contract Invocation Helpers ──

  private async callReadOnly(
    contractId: string,
    method: string,
    args: xdr.ScVal[] = [],
  ): Promise<unknown> {
    const contract = new Contract(contractId);
    const tx = new TransactionBuilder(new Account(Keypair.random().publicKey(), '0'), {
      fee: '100',
      networkPassphrase: (await this.getNetwork()).passphrase,
    })
      .addOperation(contract.call(method, ...args))
      .setTimeout(0)
      .build();

    const simulation = await this.stellarClient.simulateTx(tx);
    if (SorobanRpc.Api.isSimulationError(simulation)) {
      throw new Error(`Simulation failed: ${simulation.error}`);
    }

    if (!SorobanRpc.Api.isSimulationSuccess(simulation) || !simulation.result) {
      return null;
    }

    return scValToNative(simulation.result.retval);
  }

  private async invokeContract(
    contractId: string,
    method: string,
    args: xdr.ScVal[] = [],
  ): Promise<unknown> {
    const keypair = this.stellarClient.getKeypair();
    const network = await this.getNetwork();
    const account = await this.buildAccount(keypair);

    const contract = new Contract(contractId);
    let tx = new TransactionBuilder(account, {
      fee: '100',
      networkPassphrase: network.passphrase,
    })
      .addOperation(contract.call(method, ...args))
      .setTimeout(30)
      .build();

    tx = await this.stellarClient.prepareTx(tx);
    tx.sign(keypair);

    return this.stellarClient.sendTx(tx);
  }

  // ── Credit Token ──

  async getBalance(tokenId: string, address: string): Promise<BigNumber> {
    const result = await this.callReadOnly(tokenId, 'balance', [new Address(address).toScVal()]);
    return new BigNumber(result?.toString() || '0');
  }

  async getTotalSupply(tokenId: string): Promise<BigNumber> {
    const result = await this.callReadOnly(tokenId, 'total_supply');
    return new BigNumber(result?.toString() || '0');
  }

  async getTotalRetired(tokenId: string): Promise<BigNumber> {
    const result = await this.callReadOnly(tokenId, 'total_retired');
    return new BigNumber(result?.toString() || '0');
  }

  async mintCredits(tokenId: string, to: string, amount: BigNumber): Promise<unknown> {
    return this.invokeContract(tokenId, 'mint', [
      new Address(to).toScVal(),
      nativeToScVal(amount.toFixed(0), { type: 'i128' }),
    ]);
  }

  async retireCredits(
    tokenId: string,
    amount: BigNumber,
    purpose: string,
    metadataUri: string,
  ): Promise<unknown> {
    return this.invokeContract(tokenId, 'retire', [
      nativeToScVal(amount.toFixed(0), { type: 'i128' }),
      nativeToScVal(purpose, { type: 'string' }),
      nativeToScVal(metadataUri, { type: 'string' }),
    ]);
  }

  // ── Factory / Project Registry ──

  async registerProject(
    factoryId: string,
    owner: string,
    metadata: Record<string, unknown>,
  ): Promise<unknown> {
    return this.invokeContract(factoryId, 'register', [
      new Address(owner).toScVal(),
      nativeToScVal(JSON.stringify(metadata), { type: 'string' }),
    ]);
  }

  async getProjectContract(factoryId: string, projectId: string): Promise<string> {
    return this.callReadOnly(factoryId, 'get', [
      nativeToScVal(projectId, { type: 'string' }),
    ]) as Promise<string>;
  }

  // ── Oracle ──

  async submitReading(
    oracleContractId: string,
    projectId: string,
    reading: { value: number },
    nonce: number,
  ): Promise<{ txHash: string; response: SorobanRpc.Api.GetTransactionResponse }> {
    const keypair = this.stellarClient.getKeypair();
    const network = await this.getNetwork();
    const account = await this.buildAccount(keypair);

    const contract = new Contract(oracleContractId);
    let tx = new TransactionBuilder(account, {
      fee: '100',
      networkPassphrase: network.passphrase,
    })
      .addOperation(
        contract.call(
          'submit_reading',
          nativeToScVal(projectId, { type: 'string' }),
          nativeToScVal(reading.value, { type: 'i128' }),
          nativeToScVal(nonce, { type: 'u32' }),
        ),
      )
      .setTimeout(30)
      .build();

    tx = await this.stellarClient.prepareTx(tx);
    tx.sign(keypair);

    return this.stellarClient.sendTxWithHash(tx);
  }

  async addOracle(oracleContractId: string, oracleAddress: string): Promise<unknown> {
    return this.invokeContract(oracleContractId, 'add_oracle', [
      new Address(oracleAddress).toScVal(),
    ]);
  }

  // ── Governance ──

  async getProtocolConfig(governanceId: string): Promise<unknown> {
    return this.callReadOnly(governanceId, 'get_config');
  }

  async createProposal(
    governanceId: string,
    title: string,
    description: string,
    action: Record<string, unknown>,
  ): Promise<unknown> {
    return this.invokeContract(governanceId, 'propose', [
      nativeToScVal(title, { type: 'string' }),
      nativeToScVal(description, { type: 'string' }),
      nativeToScVal(JSON.stringify(action), { type: 'string' }),
    ]);
  }

  async vote(governanceId: string, proposalId: number, support: boolean): Promise<unknown> {
    return this.invokeContract(governanceId, 'vote', [
      nativeToScVal(proposalId, { type: 'u32' }),
      nativeToScVal(support, { type: 'bool' }),
    ]);
  }

  async execute(governanceId: string, proposalId: number): Promise<unknown> {
    return this.invokeContract(governanceId, 'execute', [
      nativeToScVal(proposalId, { type: 'u32' }),
    ]);
  }

  // ── Events ──

  async getEvents(filter: {
    startLedger?: number;
    contractIds?: string[];
    topics?: string[][];
  }): Promise<unknown[]> {
    // Uses stellarClient to query getEvents
    const response = await this.stellarClient.getServer().getEvents({
      startLedger: filter.startLedger,
      filters:
        filter.contractIds?.map((id) => ({
          contractIds: [id],
          topics: filter.topics,
        })) || [],
    });
    return response.events;
  }

  async streamEvents(
    filter: { contractIds: string[]; topics?: string[][] },
    _callback: (event: unknown) => void,
  ): Promise<void> {
    this.logger.log(`Streaming events for contracts: ${filter.contractIds.join(', ')}`);
    // In a real app, this would be a long-running process or a subscription
    // For now, we'll just log it
  }
}
