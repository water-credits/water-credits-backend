import { Entity, PrimaryColumn, Column, UpdateDateColumn } from 'typeorm';

/**
 * Scope key used for the row that tracks the scheduler as a whole (as opposed
 * to the per-project rows, which are keyed by project UUID).
 */
export const GLOBAL_SCHEDULE_SCOPE = 'global';

/**
 * Lightweight bookkeeping table recording when the oracle submission cycle
 * last ran, so `GET /health` can report oracle freshness.
 *
 * One row is keyed `'global'` (updated on every cycle, even a cycle that finds
 * nothing to submit) plus one row per project (updated only when that project
 * actually had batches submitted).
 */
@Entity('oracle_schedule_state')
export class OracleScheduleState {
  @PrimaryColumn({ name: 'scope_id', type: 'varchar', length: 64 })
  scopeId: string;

  @Column({ name: 'last_scheduled_at', type: 'timestamptz', nullable: true })
  lastScheduledAt: Date | null;

  /** Number of submissions enqueued during the most recent cycle. */
  @Column({ name: 'last_submission_count', type: 'int', default: 0 })
  lastSubmissionCount: number;

  /**
   * Most recent nonce drift observed for this scope's oracle address.
   *
   * Populated by `OracleSchedulerService` after each submission cycle.
   * `null` means no drift check has run yet or the RPC call failed.
   * A value with `Math.abs(lastNonceDrift) > 1` triggers `degraded`
   * status in `GET /health`.
   */
  @Column({ name: 'last_nonce_drift', type: 'int', nullable: true, default: null })
  lastNonceDrift: number | null;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
