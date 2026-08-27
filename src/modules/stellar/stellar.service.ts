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
import { BigNumber } from 'bignumber.js';

/**
 * Structured multi-parameter water-quality reading submitted to the Soroban
 * oracle contract.  Every field is optional (nullable) so sensors that do not
 * measure a particular parameter can still participate.
 *
 * At least one numeric field MUST be non-null; the oracle processor enforces
 * this before calling submitReading().
 */
export interface OracleReadingPayload {
  ph: number | null;
  turbidity: number | null;
  dissolvedOxygen: number | null;
  flowRate: number | null;
  nitrogen: number | null;
  phosphorus: number | null;
  temperature: number | null;
}

export interface CreditTokenStats {
  totalSupply: BigNumber;
  totalRetired: BigNumber;
}

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
    const tx = new TransactionBuilder(
      new Account(this.stellarClient.getSimulationKeypair().publicKey(), '0'),
      {
        fee: '100',
        networkPassphrase: (await this.getNetwork()).passphrase,
      },
    )
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

  /**
   * Snapshot of the credit-token values read from persistent Soroban storage.
   * Missing ledger entries represent an uninitialized value and are returned as 0.
   */
  async batchGetTokenStats(tokenAddresses: string[]): Promise<Map<string, CreditTokenStats>> {
    const addresses = [...new Set(tokenAddresses)];
    const stats = new Map(
      addresses.map((address) => [
        address,
        { totalSupply: new BigNumber(0), totalRetired: new BigNumber(0) },
      ]),
    );

    if (addresses.length === 0) {
      return stats;
    }

    const requests = new Map<string, { address: string; field: 'totalSupply' | 'totalRetired' }>();
    const keys: xdr.LedgerKey[] = [];
    for (const address of addresses) {
      for (const field of ['totalSupply', 'totalRetired'] as const) {
        const key = this.creditTokenLedgerKey(address, field);
        requests.set(key.toXDR('base64'), { address, field });
        keys.push(key);
      }
    }

    const values = await this.readLedgerValues(keys, requests);
    for (const [requestId, value] of values) {
      const request = requests.get(requestId);
      if (!request) {
        continue;
      }
      const current = stats.get(request.address);
      if (current) {
        current[request.field] = value;
      }
    }

    return stats;
  }

  /**
   * Reads a project's balance, total supply, and total retired values in one
   * getLedgerEntries RPC request.
   */
  async getTokenCreditDetails(
    tokenId: string,
    address: string | null,
  ): Promise<{ balance: BigNumber | null; totalSupply: BigNumber; totalRetired: BigNumber }> {
    const requests = new Map<string, 'balance' | 'totalSupply' | 'totalRetired'>();
    const keys: xdr.LedgerKey[] = [];
    const fields = address
      ? (['balance', 'totalSupply', 'totalRetired'] as const)
      : (['totalSupply', 'totalRetired'] as const);

    for (const field of fields) {
      const key = this.creditTokenLedgerKey(tokenId, field, address);
      requests.set(key.toXDR('base64'), field);
      keys.push(key);
    }

    const values = await this.readLedgerValues(keys, requests);
    return {
      balance: address
        ? (values.get(this.requestId(tokenId, 'balance', address)) ?? new BigNumber(0))
        : null,
      totalSupply: values.get(this.requestId(tokenId, 'totalSupply')) ?? new BigNumber(0),
      totalRetired: values.get(this.requestId(tokenId, 'totalRetired')) ?? new BigNumber(0),
    };
  }

  private creditTokenLedgerKey(
    tokenId: string,
    field: 'balance' | 'totalSupply' | 'totalRetired',
    address?: string | null,
  ): xdr.LedgerKey {
    const key =
      field === 'balance'
        ? xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('Balance'), new Address(address!).toScVal()])
        : xdr.ScVal.scvSymbol(field === 'totalSupply' ? 'TotalSupply' : 'TotalRetired');

    return xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
        contract: new Address(tokenId).toScAddress(),
        key,
        durability: xdr.ContractDataDurability.persistent(),
      }),
    );
  }

  private requestId(
    tokenId: string,
    field: 'balance' | 'totalSupply' | 'totalRetired',
    address?: string,
  ) {
    return this.creditTokenLedgerKey(tokenId, field, address).toXDR('base64');
  }

  private async readLedgerValues<T>(
    keys: xdr.LedgerKey[],
    requests: Map<string, T>,
  ): Promise<Map<string, BigNumber>> {
    const response = await this.stellarClient.getLedgerEntries(...keys);
    const values = new Map<string, BigNumber>();

    for (const entry of response.entries) {
      const requestId = entry.key.toXDR('base64');
      if (!requests.has(requestId)) {
        continue;
      }

      const contractData = entry.val.contractData();
      if (!contractData) {
        continue;
      }

      const value = scValToNative(contractData.val());
      values.set(requestId, new BigNumber(value?.toString() ?? '0'));
    }

    return values;
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

  /**
   * Same as retireCredits() but returns the txHash alongside the polled
   * response so callers (e.g. the retirement processor) can persist the
   * hash immediately.
   */
  async retireCreditsWithHash(
    tokenId: string,
    amount: BigNumber,
    purpose: string,
    metadataUri: string,
  ): Promise<{ txHash: string; response: SorobanRpc.Api.GetTransactionResponse }> {
    const keypair = this.stellarClient.getKeypair();
    const network = await this.getNetwork();
    const account = await this.buildAccount(keypair);

    const contract = new Contract(tokenId);
    let tx = new TransactionBuilder(account, {
      fee: '100',
      networkPassphrase: network.passphrase,
    })
      .addOperation(
        contract.call(
          'retire',
          nativeToScVal(amount.toFixed(0), { type: 'i128' }),
          nativeToScVal(purpose, { type: 'string' }),
          nativeToScVal(metadataUri, { type: 'string' }),
        ),
      )
      .setTimeout(30)
      .build();

    tx = await this.stellarClient.prepareTx(tx);
    tx.sign(keypair);

    return this.stellarClient.sendTxWithHash(tx);
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

  /**
   * Submit a multi-parameter water-quality reading to the Soroban oracle contract.
   *
   * The contract's `submit_reading` v2 signature is:
   *
   *   submit_reading(
   *     project_id : String,
   *     ph         : Option<i128>,   // × 1 000 (3 dp fixed-point)
   *     turbidity  : Option<i128>,   // × 1 000
   *     do         : Option<i128>,   // × 1 000  (dissolved oxygen)
   *     flow_rate  : Option<i128>,   // × 1 000
   *     nitrogen   : Option<i128>,   // × 1 000
   *     phosphorus : Option<i128>,   // × 1 000
   *     temperature: Option<i128>,   // × 1 000
   *     nonce      : u32,
   *   )
   *
   * Float values are multiplied by 1 000 and truncated to integer so the
   * contract can store them as i128 without losing sub-unit precision.
   * A `null` field is encoded as `ScVal::Void` (the Soroban None variant of
   * Option<i128>), which tells the contract the sensor did not report that
   * parameter — it is distinct from a zero reading.
   *
   * @throws {Error} if the payload contains no numeric fields at all (all null).
   */
  async submitReading(
    oracleContractId: string,
    projectId: string,
    reading: OracleReadingPayload,
    nonce: number,
  ): Promise<{ txHash: string; response: SorobanRpc.Api.GetTransactionResponse }> {
    // Encode a nullable float as Option<i128>: multiply by 1_000 and truncate.
    // null → xdr.ScVal.scvVoid() (Soroban None)
    const encodeParam = (v: number | null): xdr.ScVal =>
      v === null
        ? xdr.ScVal.scvVoid()
        : nativeToScVal(Math.trunc(Math.round(v * 1000)), { type: 'i128' });

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
          encodeParam(reading.ph),
          encodeParam(reading.turbidity),
          encodeParam(reading.dissolvedOxygen),
          encodeParam(reading.flowRate),
          encodeParam(reading.nitrogen),
          encodeParam(reading.phosphorus),
          encodeParam(reading.temperature),
          nativeToScVal(nonce, { type: 'u32' }),
        ),
      )
      .setTimeout(30)
      .build();

    tx = await this.stellarClient.prepareTx(tx);
    tx.sign(keypair);

    return this.stellarClient.sendTxWithHash(tx);
  }

  /**
   * Reads the current on-chain nonce for a given oracle address from the
   * Soroban oracle contract.  This is a read-only call; it does not create
   * a ledger entry.
   */
  async getOracleNonce(oracleContractId: string, oracleAddress: string): Promise<number> {
    const result = await this.callReadOnly(oracleContractId, 'oracle_nonce', [
      new Address(oracleAddress).toScVal(),
    ]);
    return Number(result ?? 0);
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

  /**
   * Submits the on-chain `propose(title, description, action)` call and
   * returns the u32 proposal id assigned by the Soroban governance contract.
   *
   * The id is decoded from the transaction's return value, so callers (e.g.
   * GovernanceService) can persist it as Proposal.onChainProposalId — the
   * exact value the contract's `execute()` and `vote()` methods expect.
   */
  async createProposal(
    governanceId: string,
    title: string,
    description: string,
    action: Record<string, unknown>,
  ): Promise<number> {
    const response = (await this.invokeContract(governanceId, 'propose', [
      nativeToScVal(title, { type: 'string' }),
      nativeToScVal(description, { type: 'string' }),
      nativeToScVal(JSON.stringify(action), { type: 'string' }),
    ])) as SorobanRpc.Api.GetSuccessfulTransactionResponse | null | undefined;

    if (
      !response ||
      response.status !== SorobanRpc.Api.GetTransactionStatus.SUCCESS ||
      response.returnValue === undefined
    ) {
      throw new Error('Governance propose() did not return a proposal id');
    }

    const proposalId = scValToNative(response.returnValue);
    if (typeof proposalId !== 'number' || !Number.isFinite(proposalId)) {
      throw new Error(`Governance propose() returned an unexpected value: ${String(proposalId)}`);
    }

    return proposalId;
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

  // NOTE: Event streaming / indexing is handled by IndexerService
  // (src/modules/indexer/indexer.service.ts), which polls server.getEvents()
  // on a configurable interval and dispatches typed events to the relevant DB
  // and WebSocket handlers.  The former stub streamEvents() has been removed.
  //
  // getEvents() below remains available for one-off queries (e.g. the oracle
  // controller's manual trigger path).
}
