import { Process, Processor } from '@nestjs/bull';
import { Job } from 'bull';
import { Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BigNumber } from 'bignumber.js';
import { SorobanRpc } from '@stellar/stellar-sdk';
import { Retirement } from './entities/retirement.entity';
import { StellarService } from '../stellar/stellar.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CertificateService } from './certificate.service';

export interface RetirementJobData {
  retirementId: string;
  userId: string;
  projectId: string;
  tokenId: string;
  amount: number;
  purpose: string;
  metadataUri: string;
}

@Processor('retirements')
export class CreditsRetirementProcessor {
  private readonly logger = new Logger(CreditsRetirementProcessor.name);

  constructor(
    @InjectRepository(Retirement)
    private readonly retirementRepo: Repository<Retirement>,
    private readonly stellarService: StellarService,
    private readonly notificationsService: NotificationsService,
    private readonly certificateService: CertificateService,
  ) {}

  @Process({
    name: 'process-retirement',
    concurrency: 2,
  })
  async processRetirement(job: Job<RetirementJobData>): Promise<void> {
    const { retirementId, userId, projectId, tokenId, amount, purpose, metadataUri } = job.data;

    this.logger.log(`Processing retirement ${retirementId} for project ${projectId}`);

    const retirement = await this.retirementRepo.findOne({ where: { id: retirementId } });

    if (!retirement) {
      this.logger.warn(`Retirement ${retirementId} not found, skipping`);
      return;
    }

    // Idempotency guard: if txHash is already set to a real hash, skip.
    if (retirement.txHash && !retirement.txHash.startsWith('tx-pending-')) {
      this.logger.warn(
        `Retirement ${retirementId} already has txHash ${retirement.txHash}, skipping`,
      );
      return;
    }

    // Defensive guard: retire() should always resolve tokenId before
    // enqueueing, so this is a backstop against a bad/legacy job payload
    // rather than the primary fix — never call the SDK with no contract id.
    if (!tokenId) {
      const message = `Retirement ${retirementId} has no tokenId; refusing to call the contract`;
      this.logger.error(message);
      throw new Error(message);
    }

    let txHash: string;
    let response: SorobanRpc.Api.GetTransactionResponse;

    try {
      retirement.txHash = `tx-pending-${Date.now()}`;
      await this.retirementRepo.save(retirement);

      ({ txHash, response } = await this.stellarService.retireCreditsWithHash(
        tokenId,
        new BigNumber(amount),
        purpose,
        metadataUri,
      ));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Retirement ${retirementId} failed during send: ${message}`);

      retirement.txHash = '';
      await this.retirementRepo.save(retirement);

      throw error;
    }

    if (response.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
      retirement.txHash = txHash;
      retirement.retiredAt = new Date();
      await this.retirementRepo.save(retirement);

      await this.notificationsService.notifyCreditRetired(userId, projectId, amount);

      // Best-effort, independently retryable step: pin the retirement
      // certificate to IPFS. A failed upload must NOT roll back the confirmed
      // on-chain retirement — certificateService swallows its own errors and
      // returns null, leaving retirement.certificateIpfsUri unset.
      try {
        const certificateUri =
          await this.certificateService.uploadRetirementCertificate(retirement);
        if (certificateUri) {
          retirement.certificateIpfsUri = certificateUri;
          await this.retirementRepo.save(retirement);
        } else {
          this.logger.warn(
            `Retirement ${retirementId} confirmed but certificate upload returned no URI`,
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(
          `Certificate upload for retirement ${retirementId} failed, leaving retirement confirmed: ${message}`,
        );
      }

      this.logger.log(`Retirement ${retirementId} confirmed on-chain (txHash: ${txHash})`);
    } else {
      const message = `Unexpected terminal status from retireCredits: ${response.status}`;
      this.logger.error(message);

      retirement.txHash = '';
      await this.retirementRepo.save(retirement);

      throw new Error(message);
    }
  }
}
