-- Migration: 012_sensor_batch_unique_pending
-- Fixes the race condition in SensorsService.resolveBatch() (Issue #65).
--
-- Background
-- ----------
-- resolveBatch() previously did a findOne → INSERT without any locking.  Under
-- the rated concurrency (5 Bull workers + direct HTTP ingestion) two callers
-- could simultaneously observe pending = null and each INSERT a new PENDING
-- batch for the same project, splitting the reading window and producing
-- incorrect credit calculations.
--
-- Fix (two steps)
-- ---------------
-- 1. Deduplicate any duplicate PENDING rows that exist in the table today:
--    keep the oldest batch per project (all readings already reference it via
--    batch_id FK), delete the newer empty/duplicate ones.
-- 2. Add a UNIQUE partial index on (project_id) WHERE status = 'pending'.
--    This makes a concurrent INSERT … ON CONFLICT (project_id) WHERE status =
--    'pending' DO NOTHING idempotent at the database level — the winner inserts
--    one row, every concurrent loser gets back 0 rows from the RETURNING clause,
--    re-fetches the winning row, and proceeds normally. No advisory locks needed.
--
-- Run after 011_create_indexer_cursor.sql

-- ─── Step 1: Deduplicate existing PENDING rows ────────────────────────────────
-- For each project that has more than one PENDING batch:
--   • Keep the OLDEST one (smallest created_at / id tiebreak).
--   • Re-parent any sensor_readings that reference a to-be-deleted batch so we
--     don't lose data (readings with batch_id pointing to a newer duplicate are
--     moved to the surviving oldest batch).
--   • Delete the now-empty duplicate PENDING rows.
--
-- This runs inside a transaction so it is atomic and fully reversible via
-- rollback if the subsequent DDL fails.

BEGIN;

-- Identify the batch to keep (oldest PENDING per project).
WITH ranked AS (
  SELECT
    id,
    project_id,
    created_at,
    ROW_NUMBER() OVER (
      PARTITION BY project_id
      ORDER BY created_at ASC, id ASC          -- stable tiebreak on id
    ) AS rn
  FROM reading_batches
  WHERE status = 'pending'
),
keepers AS (
  SELECT project_id, id AS keep_id
  FROM ranked
  WHERE rn = 1
),
duplicates AS (
  SELECT rb.id AS dup_id, k.keep_id
  FROM reading_batches rb
  JOIN keepers k ON k.project_id = rb.project_id
  WHERE rb.status = 'pending'
    AND rb.id <> k.keep_id
)
-- Re-parent readings from duplicate batches to the keeper before we delete.
UPDATE sensor_readings sr
SET    batch_id = d.keep_id
FROM   duplicates d
WHERE  sr.batch_id = d.dup_id;

-- Now delete the empty duplicate PENDING batches.
DELETE FROM reading_batches rb
WHERE rb.status = 'pending'
  AND EXISTS (
    SELECT 1
    FROM (
      SELECT
        id,
        project_id,
        ROW_NUMBER() OVER (
          PARTITION BY project_id
          ORDER BY created_at ASC, id ASC
        ) AS rn
      FROM reading_batches
      WHERE status = 'pending'
    ) ranked
    WHERE ranked.id = rb.id
      AND ranked.rn > 1
  );

-- ─── Step 2: Partial unique index ─────────────────────────────────────────────
-- Enforces the invariant: at most one PENDING batch per project at any moment.
-- The WHERE clause means the index is invisible once a batch transitions to
-- submitted / confirmed / failed, so historical multi-batch rows are unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS uidx_reading_batches_one_pending_per_project
  ON reading_batches (project_id)
  WHERE status = 'pending';

COMMIT;

COMMENT ON INDEX uidx_reading_batches_one_pending_per_project IS
  'Enforces at-most-one PENDING batch per project.  Enables the race-safe '
  'INSERT … ON CONFLICT (project_id) WHERE status = ''pending'' DO NOTHING '
  'pattern in SensorsService.resolveBatch().';
