import { Process, Processor } from '@nestjs/bull';
import { Job } from 'bull';
import { Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { SorobanRpc } from '@stellar/stellar-sdk';
import { OracleSubmission, SubmissionStatus } from './entities/oracle-submission.entity';
import { StellarService } from '../stellar/stellar.service';
import { In } from 'typeorm';
import { CreditScoringService } from './credit-scoring.service';
import { GovernanceConfig } from '../governance/entities/governance-config.entity';
import { Project } from '../projects/entities/project.entity';
import { ReadingBatch, BatchStatus } from '../sensors/entities/reading-batch.entity';

export interface OracleSubmitJobData {
  submissionId: string;
  projectId: string;
  oracleAddress: string;
  nonce: number;
}

/**
 * Maps the free-form readingsSnapshot JSONB stored by OracleService into the
 * scalar value expected by StellarService.submitReading().
 *
 * The contract's `submit_reading` takes a single i128 value.  We use the
 * dissolved-oxygen reading as the primary quality indicator; fall back to pH,
 * then to 0 so the call always goes through even when a sensor omits a field.
 */
function snapshotToReading(snapshot: Record<string, unknown>): { value: number } {
  const coerce = (v: unknown): number | undefined =>
    typeof v === 'number' ? v : typeof v === 'string' ? parseFloat(v) || undefined : undefined;

  const value =
    coerce(snapshot['dissolvedOxygen']) ??
    coerce(snapshot['dissolved_oxygen']) ??
    coerce(snapshot['ph']) ??
    0;

  return { value };
}

@Processor('oracle-submit')
export class OracleProcessor {
  private readonly logger = new Logger(OracleProcessor.name);

  constructor(
    @InjectRepository(OracleSubmission)
    private readonly submissionRepo: Repository<OracleSubmission>,
    @InjectRepository(GovernanceConfig)
    private readonly configRepo: Repository<GovernanceConfig>,
    @InjectRepository(Project)
    private readonly projectRepo: Repository<Project>,
    @InjectRepository(ReadingBatch)
    private readonly batchRepo: Repository<ReadingBatch>,
    private readonly stellarService: StellarService,
    private readonly configService: ConfigService,
    private readonly creditScoringService: CreditScoringService,
  ) {}

  @Process({
    name: 'oracle-submit-job',
    concurrency: 1,
  })
  async processSubmission(job: Job<OracleSubmitJobData>): Promise<void> {
    const { submissionId, projectId, oracleAddress, nonce } = job.data;

    this.logger.log(
      `Processing oracle submission ${submissionId} for project ${projectId} (nonce ${nonce})`,
    );

    const submission = await this.submissionRepo.findOne({ where: { id: submissionId } });

    if (!submission) {
      this.logger.warn(`Submission ${submissionId} not found, skipping`);
      return;
    }

    // Idempotency guard: if a previous attempt already reached CONFIRMED,
    // do not re-submit to the network.  FAILED submissions are re-tried
    // with the **same** nonce so the counter is not advanced on failure.
    if (submission.status === SubmissionStatus.CONFIRMED) {
      this.logger.warn(`Submission ${submissionId} is already CONFIRMED, skipping`);
      return;
    }

    const oracleContractId = this.configService.get<string>('oracle.contractId');

    if (!oracleContractId) {
      this.logger.error('CONTRACT_VERIFICATION_ORACLE is not configured');
      submission.status = SubmissionStatus.FAILED;
      submission.result = { error: 'Oracle contract ID not configured' };
      await this.submissionRepo.save(submission);
      throw new Error('Oracle contract ID not configured');
    }

    const reading = snapshotToReading(submission.readingsSnapshot);

    let txHash: string;
    let txResponse: SorobanRpc.Api.GetTransactionResponse;
    try {
      // sendTxWithHash() polls until ledger confirmation (up to ~60 s) or throws.
      // Mark SUBMITTED first so a process restart can detect in-flight jobs.
      submission.status = SubmissionStatus.SUBMITTED;
      await this.submissionRepo.save(submission);

      ({ txHash, response: txResponse } = await this.stellarService.submitReading(
        oracleContractId,
        projectId,
        reading,
        nonce,
      ));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Oracle submission ${submissionId} failed during send: ${message}`);

      submission.status = SubmissionStatus.FAILED;
      submission.result = { error: message };
      await this.submissionRepo.save(submission);

      // Re-throw so Bull records the failure and applies retry/backoff.
      throw error;
    }

    // submitReading() only resolves on SUCCESS; any other terminal state throws above.
    // Still guard defensively in case the interface changes.
    if (txResponse.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
      submission.status = SubmissionStatus.CONFIRMED;
      submission.txHash = txHash;
      submission.result = {
        confirmed: true,
        confirmedAt: new Date().toISOString(),
        oracleAddress,
        nonce,
        ledger: txResponse.ledger,
      };
      await this.submissionRepo.save(submission);

      this.logger.log(`Oracle submission ${submissionId} confirmed on-chain (txHash: ${txHash})`);

      // Calculate credits and update ReadingBatch
      try {
        const project = await this.projectRepo.findOne({ where: { id: projectId } });
        const config = await this.configRepo.findOne({ order: { id: 'DESC' } });

        if (project && config) {
          const credits = this.creditScoringService.calculate(
            submission.readingsSnapshot,
            config,
            Number(project.areaHectares),
          );

          // Find a pending/submitted batch to assign the credits to
          const batch = await this.batchRepo.findOne({
            where: {
              projectId,
              status: In([BatchStatus.PENDING, BatchStatus.SUBMITTED]),
            },
            order: { createdAt: 'DESC' },
          });

          if (batch) {
            batch.status = BatchStatus.CONFIRMED;
            batch.confirmedAt = new Date();
            batch.creditsGenerated = credits.toNumber();
            await this.batchRepo.save(batch);
            this.logger.log(`Calculated ${batch.creditsGenerated} credits for batch ${batch.id}`);
          } else {
            this.logger.warn(`No pending batch found for project ${projectId} to assign credits`);
          }
        } else {
          this.logger.warn(`Could not calculate credits: Project or Config missing`);
        }
      } catch (err) {
        this.logger.error(`Error calculating credits for submission ${submissionId}`, err);
      }
    } else {
      const message = `Unexpected terminal status from submitReading: ${txResponse.status}`;
      this.logger.error(message);

      submission.status = SubmissionStatus.FAILED;
      submission.result = { error: message };
      await this.submissionRepo.save(submission);

      throw new Error(message);
    }
  }
}
