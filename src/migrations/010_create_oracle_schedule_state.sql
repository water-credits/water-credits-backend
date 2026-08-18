-- Migration: 010_create_oracle_schedule_state
-- Adds the bookkeeping table behind the scheduled oracle submission cycle
-- (Issue #44).
--
-- Before this, nothing triggered oracle submissions automatically — the only
-- path was an explicit POST /oracle/trigger. OracleSchedulerService now runs on
-- a cron (ORACLE_SUBMISSION_INTERVAL_CRON, default '0 * * * *') and records here
-- when it last ran, so GET /health can report oracle freshness.
--
-- Run after 009_governance_config_changes.sql

CREATE TABLE IF NOT EXISTS oracle_schedule_state (
  -- 'global' for the scheduler as a whole, or a projects.id UUID for the
  -- per-project row. Deliberately a plain VARCHAR rather than a FK: the
  -- 'global' row has no corresponding project, and losing a project should not
  -- cascade into the health signal.
  scope_id              VARCHAR(64) PRIMARY KEY,

  -- Start time of the most recent cycle that covered this scope. The 'global'
  -- row is written on every cycle, including cycles with nothing to submit, so
  -- a stale value means the cron stopped firing rather than that no batches
  -- were due.
  last_scheduled_at     TIMESTAMPTZ,

  -- Submissions enqueued during that cycle.
  last_submission_count INT NOT NULL DEFAULT 0,

  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The health endpoint reads the 'global' row by primary key; this index serves
-- the "which projects have gone quiet" query.
CREATE INDEX IF NOT EXISTS idx_oracle_schedule_state_last_scheduled
  ON oracle_schedule_state (last_scheduled_at);

COMMENT ON TABLE oracle_schedule_state IS
  'Freshness bookkeeping for the scheduled oracle submission cycle. '
  'One row keyed ''global'' plus one row per project.';
