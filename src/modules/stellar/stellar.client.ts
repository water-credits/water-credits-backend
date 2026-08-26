import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SorobanRpc, Keypair, Transaction, xdr, TransactionBuilder, Account } from '@stellar/stellar-sdk';
import { BigNumber } from 'bignumber.js';

const DEFAULT_SIMULATION_SEED = Buffer.alloc(32);

export class FeeLimitExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FeeLimitExceededError';
  }
}

@Injectable()
export class StellarClient {
  private readonly logger = new Logger(StellarClient.name);
  private server: SorobanRpc.Server;
  private keypair: Keypair;
  private readonly simulationKeypair: Keypair;

  constructor(private configService: ConfigService) {
    const rpcUrl = this.configService.get<string>('stellar.rpcUrl')!;
    const backendSecret = this.configService.get<string>('stellar.backendSecret');
    const simulationSecret = this.configService.get<string>('stellar.simulationSecret');

    this.server = new SorobanRpc.Server(rpcUrl);
    this.simulationKeypair = simulationSecret
      ? Keypair.fromSecret(simulationSecret)
      : Keypair.fromRawEd25519Seed(DEFAULT_SIMULATION_SEED);

    if (backendSecret && backendSecret !== 'SDN...TODO') {
      this.keypair = Keypair.fromSecret(backendSecret);
    } else {
      this.logger.warn('STELLAR_BACKEND_SECRET not properly configured');
      // Using a random keypair just to avoid null checks, but transactions will fail
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

  private assertSendable(tx: Transaction): void {
    if (tx.source === this.simulationKeypair.publicKey()) {
      throw new Error('Simulation transactions must not be submitted');
    }
  }

  async simulateTx(tx: Transaction): Promise<SorobanRpc.Api.SimulateTransactionResponse> {
    return this.server.simulateTransaction(tx);
  }

  async estimateFee(tx: Transaction): Promise<string> {
    const defaultFee = '100';
    try {
      const simulation = await this.simulateTx(tx);
      if (SorobanRpc.Api.isSimulationSuccess(simulation) && simulation.minResourceFee) {
        const minResourceFee = new BigNumber(simulation.minResourceFee);
        const baseFee = new BigNumber(100);
        const total = minResourceFee.plus(baseFee);
        const multiplier = new BigNumber(this.configService.get<number>('STELLAR_FEE_MULTIPLIER') || 1.5);
        return total.multipliedBy(multiplier).toFixed(0, BigNumber.ROUND_CEIL);
      }
    } catch (e) {
      this.logger.warn(`Failed to estimate fee, falling back to default: ${e}`);
    }
    return defaultFee;
  }

  async prepareTx(tx: Transaction): Promise<Transaction> {
    return this.server.prepareTransaction(tx);
  }

  private isInsufficientFee(xdrInput: string | xdr.TransactionResult): boolean {
    try {
      let result: xdr.TransactionResult;
      
      if (typeof xdrInput === 'string') {
        const buf = Buffer.from(xdrInput, 'base64');
        result = xdr.TransactionResult.fromXDR(buf);
      } else {
        result = xdrInput;
      }
      
      return result.result().switch().name === 'txInsufficientFee';
    } catch (e) {
      return false;
    }
  }

  private async checkSequenceUnchanged(tx: Transaction): Promise<boolean> {
    try {
      const accountId = tx.source;
      const accountKey = xdr.LedgerKey.account(new xdr.LedgerKeyAccount({
        accountId: Keypair.fromPublicKey(accountId).xdrPublicKey()
      }));
      const response = await this.server.getLedgerEntries(accountKey);
      if (response.entries && response.entries.length > 0) {
        const entry = response.entries[0] as any;
        const ledgerEntryData = xdr.LedgerEntryData.fromXDR(entry.result.xdr, 'base64');
        const seqNum = ledgerEntryData.account().seqNum().toString();
        
        const txSeq = new BigNumber(tx.sequence);
        const currentSeq = new BigNumber(seqNum);
        if (currentSeq.isGreaterThanOrEqualTo(txSeq)) {
          return false;
        }
        return true;
      }
      return false;
    } catch (e) {
      return false;
    }
  }

  private createFeeBump(
    originalTx: Transaction,
    currentTx: any,
    networkPassphrase: string,
    maxStroops: BigNumber
  ) {
    let bumpedFeeBN = new BigNumber(currentTx.fee).multipliedBy(2);
    // Ensure the fee meets the minimum for fee bump
    const minRequired = new BigNumber(originalTx.fee).multipliedBy(originalTx.operations.length + 1);
    if (bumpedFeeBN.isLessThan(minRequired)) {
      bumpedFeeBN = minRequired;
    }
    if (bumpedFeeBN.isGreaterThan(maxStroops)) {
      throw new FeeLimitExceededError(`Fee limit exceeded: ${bumpedFeeBN.toString()} > ${maxStroops.toString()}`);
    }
    const bumpedFee = bumpedFeeBN.toFixed(0, BigNumber.ROUND_CEIL);

    const feeAccount = this.getKeypair().publicKey();
    const nextTx = TransactionBuilder.buildFeeBumpTransaction(
      feeAccount,
      bumpedFee,
      originalTx,
      networkPassphrase
    );
    nextTx.sign(this.getKeypair());
    return { bumpedFee, nextTx };
  }

  async sendTx(tx: Transaction): Promise<SorobanRpc.Api.GetTransactionResponse> {
    const res = await this.sendTxWithHash(tx);
    return res.response;
  }

  async sendTxWithHash(
    tx: Transaction,
  ): Promise<{ txHash: string; response: SorobanRpc.Api.GetTransactionResponse }> {
    this.assertSendable(tx);
    let currentTx: any = tx;
    let attempt = 1;
    const maxAttempts = parseInt(this.configService.get<string>('STELLAR_FEE_BUMP_MAX_RETRIES') || '3', 10);
    const maxStroops = new BigNumber(this.configService.get<string>('STELLAR_FEE_MAX_STROOPS') || '10000000');
    const networkPassphrase = this.configService.get<string>('stellar.passphrase') || 'Test SDF Network ; September 2015';

    while (attempt <= maxAttempts + 1) {
      try {
        const sendResponse = await this.server.sendTransaction(currentTx);
        if (sendResponse.status === 'ERROR') {
          const isInsufficientFee = sendResponse.errorResult && 
                                    this.isInsufficientFee(sendResponse.errorResult);
          
          if (isInsufficientFee) {
            if (attempt > maxAttempts) {
              throw new Error(`Transaction failed: ${JSON.stringify(sendResponse)}`);
            }
            const { bumpedFee, nextTx } = this.createFeeBump(tx, currentTx, networkPassphrase, maxStroops);
            this.logger.warn(`Fee bump retry`, {
              context: 'StellarClient',
              attempt,
              previousFee: currentTx.fee,
              bumpedFee,
              txHash: sendResponse.hash || tx.hash().toString('hex')
            });
            currentTx = nextTx;
            attempt++;
            continue;
          }
          throw new Error(`Transaction failed: ${JSON.stringify(sendResponse)}`);
        }

        const txHash = sendResponse.hash;
        let statusResponse = await this.server.getTransaction(txHash);
        let pollAttempts = 0;
        const maxPollAttempts = 30;

        while (pollAttempts < maxPollAttempts) {
          if (statusResponse.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
            return { txHash, response: statusResponse };
          }

          if (statusResponse.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
            if (statusResponse.resultXdr && this.isInsufficientFee(statusResponse.resultXdr)) {
                break;
            }
            throw new Error(`Transaction failed: ${statusResponse.resultXdr}`);
          }

          await new Promise((resolve) => setTimeout(resolve, 2000));
          statusResponse = await this.server.getTransaction(txHash);
          pollAttempts++;
        }

        if (statusResponse.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
            return { txHash, response: statusResponse };
        } else if (statusResponse.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
             if (statusResponse.resultXdr && this.isInsufficientFee(statusResponse.resultXdr)) {
                 if (attempt > maxAttempts) {
                     throw new Error(`Transaction failed: ${statusResponse.resultXdr}`);
                 }
                 const { bumpedFee, nextTx } = this.createFeeBump(tx, currentTx, networkPassphrase, maxStroops);
                 this.logger.warn(`Fee bump retry`, {
                   context: 'StellarClient',
                   attempt,
                   previousFee: currentTx.fee,
                   bumpedFee,
                   txHash
                 });
                 currentTx = nextTx;
                 attempt++;
                 continue;
             }
        } else {
            // TIMEOUT
            if (attempt > maxAttempts) {
                throw new Error(`Transaction polling timed out for ${txHash}`);
            }

            const sequenceUnchanged = await this.checkSequenceUnchanged(tx);
            if (!sequenceUnchanged) {
                throw new Error(`Transaction polling timed out for ${txHash} and sequence advanced`);
            }

            const { bumpedFee, nextTx } = this.createFeeBump(tx, currentTx, networkPassphrase, maxStroops);
            this.logger.warn(`Fee bump retry (timeout)`, {
              context: 'StellarClient',
              attempt,
              previousFee: currentTx.fee,
              bumpedFee,
              txHash
            });
            currentTx = nextTx;
            attempt++;
            continue;
        }

      } catch (err) {
        if (err instanceof FeeLimitExceededError) {
          throw err;
        }
        throw err;
      }
    }
    
    throw new Error(`Max fee bump attempts reached`);
  }

  async getLedgerEntries(
    ...keys: xdr.LedgerKey[]
  ): Promise<SorobanRpc.Api.GetLedgerEntriesResponse> {
    return this.server.getLedgerEntries(...keys);
  }
}
