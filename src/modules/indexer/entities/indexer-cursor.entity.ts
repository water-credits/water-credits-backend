import {
  Entity,
  PrimaryColumn,
  Column,
  UpdateDateColumn,
} from 'typeorm';

/**
 * The well-known cursor key used by the singleton indexer instance.
 * Additional keys (e.g. per-contract cursors) can be added without a schema
 * change, but the indexer only reads/writes this one.
 */
export const MAIN_CURSOR_KEY = 'main';

/**
 * Single-row table that persists the last Soroban ledger sequence fully
 * processed by the event indexer.  Survives pod restarts so the indexer
 * continues from where it left off rather than re-processing history or
 * silently skipping events.
 *
 * Schema lives in src/migrations/011_create_indexer_cursor.sql.
 */
@Entity('indexer_cursor')
export class IndexerCursor {
  @PrimaryColumn({ name: 'cursor_key', type: 'varchar', length: 64 })
  cursorKey: string;

  /**
   * The last ledger whose events have been fully processed and committed to
   * the database.  NULL on first boot — the indexer seeds from
   * (latest_ledger - 1) in that case.
   */
  @Column({ name: 'last_indexed_ledger', type: 'int', nullable: true })
  lastIndexedLedger: number | null;

  /**
   * Timestamp of the last successful poll cycle.  Reported in GET /health.
   */
  @Column({ name: 'last_indexed_at', type: 'timestamptz', nullable: true })
  lastIndexedAt: Date | null;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
