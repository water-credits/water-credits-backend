import { registerAs } from '@nestjs/config';

/**
 * Default cron expression for the scheduled oracle submission cycle.
 * Matches the hourly cadence documented in the README architecture tables.
 */
export const DEFAULT_ORACLE_SUBMISSION_CRON = '0 * * * *';

/**
 * How long a submission cycle may be absent before `GET /health` reports the
 * oracle as stale.  Defaults to two hourly cycles.
 */
export const DEFAULT_ORACLE_STALENESS_THRESHOLD_S = 7200;

export default registerAs('oracle', () => ({
  contractId: process.env.ORACLE_CONTRACT_ID || '',
  trustedSigners: (process.env.ORACLE_TRUSTED_SIGNERS || '').split(',').filter(Boolean),
  /**
   * Stellar address the scheduler submits as.  When empty the scheduled cycle
   * is skipped (manual `POST /oracle/trigger` still works, it carries its own
   * oracle address in the request body).
   */
  address: process.env.ORACLE_ADDRESS || '',
  /**
   * Set to `false` to keep the cron registered but inert — useful for local
   * development and for replicas that must not submit.
   */
  schedulerEnabled: process.env.ORACLE_SCHEDULER_ENABLED !== 'false',
  submissionIntervalCron:
    process.env.ORACLE_SUBMISSION_INTERVAL_CRON || DEFAULT_ORACLE_SUBMISSION_CRON,
  stalenessThresholdSeconds: parseInt(
    process.env.ORACLE_STALENESS_THRESHOLD_S || `${DEFAULT_ORACLE_STALENESS_THRESHOLD_S}`,
    10,
  ),
}));
