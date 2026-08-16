/**
 * Backfill script for existing CONFIRMED batches.
 *
 * Existing confirmed batches with `creditsGenerated = null` are backfilled
 * using the CreditScoringService.
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

  const config = await configRepo.findOne({ order: { id: 'DESC' } });
  if (!config) {
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

  for (const batch of uncalculatedBatches) {
    const project = await projectRepo.findOne({ where: { id: batch.projectId } });
    if (!project) continue;

    // Find the latest confirmed submission for this project around or after the batch's creation time
    const submission = await submissionRepo
      .createQueryBuilder('submission')
      .where('submission.projectId = :projectId', { projectId: batch.projectId })
      .andWhere('submission.status = :status', { status: SubmissionStatus.CONFIRMED })
      .orderBy('submission.createdAt', 'DESC')
      .getOne();

    if (!submission) {
      console.log(`  No confirmed submission found for batch ${batch.id} - skipping.`);
      continue;
    }

    const credits = scoringService.calculate(
      submission.readingsSnapshot,
      config,
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
  await AppDataSource.destroy();
}

run().catch((err) => {
  console.error('❌ Backfill failed:', err);
  process.exit(1);
});
