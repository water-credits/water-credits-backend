/**
 * Backfill script for existing CONFIRMED batches.
 *
 * Confirmed batches with `creditsGenerated = null` are backfilled using the
 * CreditScoringService.  The scoring formula is governance-configurable, so a
 * backfill must reproduce the credits that would have been generated when the
 * batch was originally confirmed.
 *
 * Historical scoring semantics
 * ----------------------------
 * The oracle processor embeds a `configSnapshot` inside `submission.result`
 * every time a submission is confirmed.  That snapshot is the governance
 * configuration that was in effect at confirmation time, and it is the
 * authoritative input for credit calculation (the same snapshot is reused on
 * retries so results are deterministic).
 *
 * This script therefore prefers the stored snapshot.  Only if a submission was
 * confirmed before snapshots existed (legacy rows) does it fall back to the
 * current live governance config.  This keeps backfilled credits consistent
 * with the audit trail rather than silently re-pricing history under whatever
 * config happens to be live today.
 */

import 'reflect-metadata';
import { DataSource } from 'typeorm';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

import {
  OracleSubmission,
  SubmissionStatus,
} from '../modules/oracle/entities/oracle-submission.entity';
import { ReadingBatch, BatchStatus } from '../modules/sensors/entities/reading-batch.entity';
import { GovernanceConfig } from '../modules/governance/entities/governance-config.entity';
import { Project } from '../modules/projects/entities/project.entity';
import { CreditScoringService } from '../modules/oracle/credit-scoring.service';

const AppDataSource = new DataSource({
  type: 'postgres',
  host: process.env.DATABASE_HOST ?? 'localhost',
  port: parseInt(process.env.DATABASE_PORT ?? '5432', 10),
  username: process.env.DATABASE_USER ?? 'postgres',
  password: process.env.DATABASE_PASSWORD ?? 'postgres',
  database: process.env.DATABASE_NAME ?? 'water_credits',
  synchronize: false,
  logging: false,
  entities: [OracleSubmission, ReadingBatch, GovernanceConfig, Project],
});

async function run() {
  await AppDataSource.initialize();
  console.log('✅ Connected to database');

  const submissionRepo = AppDataSource.getRepository(OracleSubmission);
  const batchRepo = AppDataSource.getRepository(ReadingBatch);
  const configRepo = AppDataSource.getRepository(GovernanceConfig);
  const projectRepo = AppDataSource.getRepository(Project);

  const scoringService = new CreditScoringService();

  // Live config is only used as a fallback for legacy confirmed submissions that
  // were finalised before the processor started embedding a configSnapshot.
  const liveConfig = await configRepo.findOne({ order: { id: 'DESC' } });
  if (!liveConfig) {
    console.error('❌ No GovernanceConfig found');
    process.exit(1);
  }

  // Find all uncalculated batches
  const uncalculatedBatches = await batchRepo
    .createQueryBuilder('batch')
    .where('batch.creditsGenerated IS NULL')
    // We only care about batches that might correspond to confirmed submissions.
    // Let's just find ALL batches with creditsGenerated = null that have related confirmed submissions.
    .getMany();

  console.log(`Found ${uncalculatedBatches.length} batches with no credits generated.`);

  let updatedCount = 0;
  let skippedNoSubmission = 0;
  let skippedNoSnapshot = 0;

  for (const batch of uncalculatedBatches) {
    const project = await projectRepo.findOne({ where: { id: projectId: batch.projectId } });
    if (!project) continue;

    const submission = await submissionRepo.findOne({
      where: {
        batchId: batch.id,
        projectId: batch.projectId,
        status: SubmissionStatus.CONFIRMED,
      },
    });

    if (!submission) {
      console.log(`  No confirmed submission linked to batch ${batch.id} - skipping.`);
      skippedNoSubmission++;
      continue;
    }

    // Prefer the snapshot captured at confirmation time so backfilled credits
    // match the audit trail.  Fall back to live config for legacy rows.
    const snapshotFromResult = extractSnapshot(submission);
    const config = snapshotFromResult ?? liveConfig;
    if (!snapshotFromResult) {
      skippedNoSnapshot++;
    }

    const credits = scoringService.calculate(
      submission.readingsSnapshot,
      config as GovernanceConfig,
      Number(project.areaHectares),
    );

    batch.creditsGenerated = credits.toNumber();
    batch.status = BatchStatus.CONFIRMED;
    if (!batch.confirmedAt) {
      batch.confirmedAt = new Date();
    }

    await batchRepo.save(batch);
    updatedCount++;
    console.log(`  Batch ${batch.id}: calculated ${batch.creditsGenerated} credits.`);
  }

  console.log(`\n✅ Backfill complete. Updated ${updatedCount} batches.`);
  console.log(`   Skipped (no confirmed submission): ${skippedNoSubmission}`);
  console.log(`   Used live-config fallback (no snapshot): ${skippedNoSnapshot}`);
  await AppDataSource.destroy();
}

/**
 * Pulls the governance config snapshot that the processor embedded in
 * `submission.result` at confirmation time.  Returns null when the row predates
 * snapshots or the payload is malformed, signalling the caller to fall back to
 * the live config.
 */
function extractSnapshot(submission: OracleSubmission): GovernanceConfig | null {
  const result = submission.result as Record<string, unknown> | null;
  const snapshot = result?.configSnapshot as Partial<GovernanceConfig> | undefined;
  if (!snapshot) return null;

  // A valid snapshot must carry the scoring-relevant fields.  If any are
  // missing we treat it as absent rather than scoring with partial data.
  const required: (keyof GovernanceConfig)[] = [
    'weightVolumetric',
    'weightNitrogen',
    'weightPhosphorus',
    'phPenaltyFactor',
    'tempPenaltyFactor',
    'nutrientDivisor',
  ];
  for (const key of required) {
    if (snapshot[key] === undefined || snapshot[key] === null) {
      return null;
    }
  }
  return snapshot as GovernanceConfig;

run().catch((err) => {
  console.error('❌ Backfill failed:', err);
  process.exit(1);
});
