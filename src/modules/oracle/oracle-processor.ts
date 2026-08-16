import { Process, Processor } from '@nestjs/bull';
import { Job } from 'bull';
import { Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { SorobanRpc } from '@stellar/stellar-sdk';
import { OracleSubmission, SubmissionStatus } from './entities/oracle-submission.entity';
import { GovernanceConfig } from '../governance/entities/governance-config.entity';
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
  /**
   * Snapshot of the GovernanceConfig taken at the moment the job was enqueued
   * (i.e. at batch-start).  Using this snapshot throughout the processor
   * guarantees that a mid-batch config change cannot alter the scoring formula
   * partway through a batch.
   *
   * If not present (legacy jobs enqueued before this field was added), the
   * processor falls back to reading the live config from the database.
   */
  configSnapshot?: GovernanceConfigSnapshot;
}

/**
 * A plain-object copy of the fields from GovernanceConfig that the processor
 * actually uses for credit scoring.  Kept flat so it serialises cleanly into
 * the Bull job payload (no class instances, no circular refs).
 */
export interface GovernanceConfigSnapshot {
  protocolFeeBps: number;
  minOracleConfirmations: number;
  phMin: number | null;
  phMax: number | null;
  doThreshold: number | null;
  tempPenaltyDelta: number | null;
  weightVolumetric: number;
  weightNitrogen: number;
  weightPhosphorus: number;
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
    private readonly governanceConfigRepo: Repository<GovernanceConfig>,
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

    // ── Snapshot config at batch-start ────────────────────────────────────
    //
    // Capture governance config NOW (at job execution start) so that if a
    // scheduled config-change fires while this batch is in-flight, it does
    // not alter the scoring parameters mid-batch.
    //
    // Prefer the snapshot baked into the job payload (set by OracleService
    // when the job was enqueued) for consistency across retries; fall back to
    // reading the live config so legacy jobs still work.
    const govConfig: GovernanceConfigSnapshot =
      job.data.configSnapshot ?? (await this.loadLiveConfigSnapshot());

    this.logger.debug(
      `Using config snapshot for submission ${submissionId}: ` +
        `doThreshold=${govConfig.doThreshold}, ` +
        `weightVolumetric=${govConfig.weightVolumetric}`,
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

    // Apply the snapshotted scoring thresholds to the raw reading before
    // forwarding to the contract.  Using the snapshot here means the scoring
    // formula is fixed for the entire lifetime of this job, even across retries.
    const reading = this.scoreReading(
      snapshotToReading(submission.readingsSnapshot),
      govConfig,
    );

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
        // Embed the snapshot so auditors can see exactly which parameters
        // were in effect when this submission was scored.
        configSnapshot: govConfig,
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

  // ── Helpers ───────────────────────────────────────────────────────────────

  /**
   * Reads the live governance config row and extracts only the scoring-relevant
   * fields into a plain snapshot object.
   */
  private async loadLiveConfigSnapshot(): Promise<GovernanceConfigSnapshot> {
    const config = await this.governanceConfigRepo.findOne({ where: {} as Record<string, never> });

    // Fall back to safe defaults if the config row doesn't exist yet.
    return {
      protocolFeeBps: config?.protocolFeeBps ?? 100,
      minOracleConfirmations: config?.minOracleConfirmations ?? 3,
      phMin: config?.phMin ?? null,
      phMax: config?.phMax ?? null,
      doThreshold: config?.doThreshold ?? null,
      tempPenaltyDelta: config?.tempPenaltyDelta ?? null,
      weightVolumetric: config?.weightVolumetric ?? 0.5,
      weightNitrogen: config?.weightNitrogen ?? 0.3,
      weightPhosphorus: config?.weightPhosphorus ?? 0.2,
    };
  }

  /**
   * Applies governance thresholds to the raw reading value.
   *
   * Currently applies a simple quality penalty:
   *   - If doThreshold is set and the reading value is below it, the value is
   *     penalised by 20% to reflect degraded water quality.
   *
   * Extend this method as the scoring formula evolves; the snapshot contract
   * guarantees all parameters here came from the same config version.
   */
  private scoreReading(
    reading: { value: number },
    config: GovernanceConfigSnapshot,
  ): { value: number } {
    let { value } = reading;

    if (config.doThreshold !== null && value < config.doThreshold) {
      // Below DO threshold: apply a quality penalty.
      value = Math.round(value * 0.8);
      this.logger.debug(
        `DO below threshold (${config.doThreshold}): penalising reading value to ${value}`,
      );
    }

    return { value };
  }
}
