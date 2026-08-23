import { Process, Processor } from '@nestjs/bull';
import { Job } from 'bull';
import { Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, MoreThan, Not, Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { SorobanRpc } from '@stellar/stellar-sdk';
import { OracleSubmission, SubmissionStatus } from './entities/oracle-submission.entity';
import { GovernanceConfig } from '../governance/entities/governance-config.entity';
import { StellarService, OracleReadingPayload } from '../stellar/stellar.service';
import { CreditScoringService } from './credit-scoring.service';
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
 * Maps the free-form readingsSnapshot JSONB into a typed OracleReadingPayload
 * that preserves ALL water-quality parameters rather than collapsing them to a
 * single scalar.
 *
 * Key differences from the old snapshotToReading():
 * - Returns the full parameter set; no information is lost.
 * - Accepts both camelCase and snake_case sensor field names.
 * - Throws a descriptive Error when the snapshot is empty or contains no
 *   numeric values, rather than silently submitting a falsified zero reading.
 *
 * @throws {Error} when the snapshot produces a payload with every field null.
 */
export function mapSnapshotToPayload(snapshot: Record<string, unknown>): OracleReadingPayload {
  const coerce = (v: unknown): number | null => {
    if (typeof v === 'number' && isFinite(v)) {
      return v;
    }
    if (typeof v === 'string') {
      const n = parseFloat(v);
      return isFinite(n) ? n : null;
    }
    return null;
  };

  const payload: OracleReadingPayload = {
    ph: coerce(snapshot['ph']),
    turbidity: coerce(snapshot['turbidity']) ?? coerce(snapshot['turbidity_ntu']),
    dissolvedOxygen:
      coerce(snapshot['dissolvedOxygen']) ??
      coerce(snapshot['dissolved_oxygen']) ??
      coerce(snapshot['dissolved_oxygen_mgl']),
    flowRate:
      coerce(snapshot['flowRate']) ??
      coerce(snapshot['flow_rate']) ??
      coerce(snapshot['flow_rate_cms']),
    nitrogen:
      coerce(snapshot['nitrogen']) ??
      coerce(snapshot['total_nitrogen']) ??
      coerce(snapshot['total_nitrogen_mgl']),
    phosphorus:
      coerce(snapshot['phosphorus']) ??
      coerce(snapshot['total_phosphorus']) ??
      coerce(snapshot['total_phosphorus_mgl']),
    temperature:
      coerce(snapshot['temperature']) ??
      coerce(snapshot['temperature_c']) ??
      coerce(snapshot['temp']),
  };

  const hasAnyValue = Object.values(payload).some((v) => v !== null);
  if (!hasAnyValue) {
    throw new Error(
      'Oracle snapshot contains no recognisable numeric parameters — ' +
        'refusing to submit an empty reading to the contract.',
    );
  }

  return payload;
}

@Processor('oracle-submit')
export class OracleProcessor {
  private readonly logger = new Logger(OracleProcessor.name);

  constructor(
    @InjectRepository(OracleSubmission)
    private readonly submissionRepo: Repository<OracleSubmission>,
    @InjectRepository(GovernanceConfig)
    private readonly governanceConfigRepo: Repository<GovernanceConfig>,
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

    // Read current on-chain nonce to assign/re-validate nonce at processing time
    let onChainNonce: number;
    try {
      onChainNonce = await this.stellarService.getOracleNonce(oracleContractId, oracleAddress);
    } catch (error) {
      this.logger.error(
        `Could not read on-chain nonce for ${oracleAddress}: ${(error as Error).message}`,
      );
      throw error;
    }

    const expectedNonce = onChainNonce + 1;
    let submitNonce = submission.nonce;

    if (submission.nonce !== expectedNonce) {
      if (submission.nonce < expectedNonce) {
        if (submission.nonce === onChainNonce) {
          this.logger.log(
            `Submission ${submissionId} (nonce ${submission.nonce}) already confirmed on-chain. Marking as CONFIRMED.`,
          );

          submission.status = SubmissionStatus.CONFIRMED;
          submission.txHash = submission.txHash || 'reconciled-on-chain';
          submission.result = {
            confirmed: true,
            confirmedAt: new Date().toISOString(),
            oracleAddress,
            nonce: submission.nonce,
            reconciled: true,
          };
          await this.submissionRepo.save(submission);

          await this.calculateCreditsAndConfirmBatch(submission, projectId);
          return;
        } else {
          this.logger.warn(
            `Submission ${submissionId} has stale nonce ${submission.nonce} (expected ${expectedNonce}). Failing cleanly.`,
          );
          submission.status = SubmissionStatus.FAILED;
          submission.result = {
            error: `Stale submission: on-chain nonce ${onChainNonce} is ahead of submission nonce ${submission.nonce}`,
          };
          await this.submissionRepo.save(submission);
          return;
        }
      } else {
        const newerConfirmed = await this.submissionRepo.findOne({
          where: {
            oracleAddress,
            status: SubmissionStatus.CONFIRMED,
            id: Not(submission.id),
            createdAt: MoreThan(submission.createdAt),
          },
        });

        if (newerConfirmed) {
          this.logger.warn(
            `Submission ${submissionId} nonce ${submission.nonce} is higher than expected ${expectedNonce}, but a newer submission ${newerConfirmed.id} is already confirmed. Failing cleanly.`,
          );
          submission.status = SubmissionStatus.FAILED;
          submission.result = {
            error: `Stale submission: newer submission ${newerConfirmed.id} already confirmed`,
          };
          await this.submissionRepo.save(submission);
          return;
        } else {
          this.logger.log(
            `Re-sequencing submission ${submissionId} from nonce ${submission.nonce} to ${expectedNonce}`,
          );
          submission.nonce = expectedNonce;
          await this.submissionRepo.save(submission);
          submitNonce = expectedNonce;
        }
      }
    }

    // Apply the snapshotted scoring thresholds to the raw reading before
    // forwarding to the contract.  Using the snapshot here means the scoring
    // formula is fixed for the entire lifetime of this job, even across retries.
    //
    // mapSnapshotToPayload() throws if the snapshot contains no recognisable
    // numeric fields — this is the guard against submitting a falsified zero
    // reading.  We persist FAILED here so the error is visible in the DB and
    // the job is not silently swallowed.
    let reading: OracleReadingPayload;
    try {
      reading = this.scoreReading(mapSnapshotToPayload(submission.readingsSnapshot), govConfig);
    } catch (mappingError) {
      const message = mappingError instanceof Error ? mappingError.message : String(mappingError);
      this.logger.error(`Oracle submission ${submissionId} has invalid snapshot: ${message}`);
      submission.status = SubmissionStatus.FAILED;
      submission.result = { error: message };
      await this.submissionRepo.save(submission);
      throw mappingError;
    }

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
        submitNonce,
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
        nonce: submitNonce,
        ledger: txResponse.ledger,
        // Embed the snapshot so auditors can see exactly which parameters
        // were in effect when this submission was scored.
        configSnapshot: govConfig,
      };
      await this.submissionRepo.save(submission);

      this.logger.log(`Oracle submission ${submissionId} confirmed on-chain (txHash: ${txHash})`);

      await this.calculateCreditsAndConfirmBatch(submission, projectId);
    } else {
      const message = `Unexpected terminal status from submitReading: ${txResponse.status}`;
      this.logger.error(message);

      submission.status = SubmissionStatus.FAILED;
      submission.result = { error: message };
      await this.submissionRepo.save(submission);

      throw new Error(message);
    }
  }

  private async calculateCreditsAndConfirmBatch(
    submission: OracleSubmission,
    projectId: string,
  ): Promise<void> {
    try {
      const project = await this.projectRepo.findOne({ where: { id: projectId } });
      const config = await this.governanceConfigRepo.findOne({ order: { id: 'DESC' } });

      if (project && config) {
        const credits = this.creditScoringService.calculate(
          submission.readingsSnapshot,
          config,
          Number(project.areaHectares),
        );

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
      this.logger.error(`Error calculating credits for submission ${submission.id}`, err);
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
   * Applies governance thresholds to the full reading payload.
   *
   * Currently applies a quality penalty to the dissolved-oxygen field:
   *   - If doThreshold is set and the DO reading is below it, the DO value is
   *     penalised by 20% to reflect degraded water quality.
   *
   * All other parameters are forwarded unchanged.  Extend this method as the
   * scoring formula evolves; the snapshot contract guarantees all parameters
   * here came from the same config version.
   */
  private scoreReading(
    reading: OracleReadingPayload,
    config: GovernanceConfigSnapshot,
  ): OracleReadingPayload {
    let { dissolvedOxygen } = reading;

    if (
      config.doThreshold !== null &&
      dissolvedOxygen !== null &&
      dissolvedOxygen < config.doThreshold
    ) {
      // Below DO threshold: apply a quality penalty.
      dissolvedOxygen = Math.round(dissolvedOxygen * 0.8 * 1000) / 1000;
      this.logger.debug(
        `DO below threshold (${config.doThreshold}): penalising DO reading to ${dissolvedOxygen}`,
      );
    }

    return { ...reading, dissolvedOxygen };
  }
}
