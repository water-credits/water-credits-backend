-- Migration: 011_create_indexer_cursor
-- Persists the last Soroban ledger sequence the event indexer has fully
-- processed so a pod restart continues from where it left off without
-- re-indexing the full ledger history or silently skipping events.
--
-- A single row keyed 'main' is used (the indexer is a global singleton
-- process, not per-project).  Additional rows are reserved for future use
-- (e.g. per-contract cursors) without a schema change.
--
-- Run after 010_create_oracle_schedule_state.sql

CREATE TABLE IF NOT EXISTS indexer_cursor (
  -- Stable identifier.  'main' is the only value used today.
  cursor_key          VARCHAR(64) PRIMARY KEY,

  -- The last ledger whose events have been fully processed and committed to
  -- the database.  NULL means the indexer has never run; it will seed from
  -- (latest_ledger - 1) on first boot.
  last_indexed_ledger INT,

  -- ISO-8601 timestamp of the last successful poll cycle.  Used by
  -- GET /health to report indexer freshness.
  last_indexed_at     TIMESTAMPTZ,

  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE indexer_cursor IS
  'Persistence for the Soroban event-indexer ledger cursor. '
  'Prevents re-processing events after a restart and enables gap detection.';

-- Seed the single well-known row so the indexer never has to INSERT.
INSERT INTO indexer_cursor (cursor_key, last_indexed_ledger, last_indexed_at)
VALUES ('main', NULL, NULL)
ON CONFLICT (cursor_key) DO NOTHING;
