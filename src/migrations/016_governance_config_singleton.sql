-- Migration: 016_governance_config_singleton
-- Fixes the governance_config singleton race described in the "protocol
-- config must be a single, stable source of truth" issue.
--
-- Background
-- ----------
-- GovernanceService.getConfig() read the "live" config with
-- findOne({ where: {} }) — no id filter, no ORDER BY — and relied on the
-- table holding exactly one row. Nothing in the schema enforced that: two
-- concurrent getConfig() calls hitting an empty table could both observe
-- "no row exists" and both INSERT, producing two rows. From then on,
-- getConfig() would return whichever row Postgres happened to hand back
-- first, and emergencyConfigUpdate() / applySingleChange() blindly
-- Object.assign + save onto that arbitrary row — silently forking protocol
-- behavior (fees, quorum, voting/timelock periods) depending on which row
-- got picked.
--
-- The codebase already has an implicit convention that row id = 1 is THE
-- config row (src/scripts/seed.ts inserts it with id: 1; migration 006
-- backfills `WHERE id = 1`). This migration turns that convention into a
-- hard database guarantee instead of an assumption, and reconciles any
-- duplicate rows that already exist under the old, unconstrained schema.
--
-- Fix (two steps)
-- ---------------
-- 1. Reconcile duplicates:
--      a. If id = 1 doesn't already exist, materialize it from the most
--         recently updated existing row (the best available signal for
--         "current" protocol parameters), ties broken by the smallest id.
--      b. Re-point every governance_config_changes audit row from whatever
--         config id it referenced onto id = 1 — done BEFORE the delete below
--         so we don't rely on ON DELETE CASCADE, which would silently
--         destroy audit history for the losing rows.
--      c. Delete every governance_config row except id = 1.
-- 2. Add CHECK (id = 1). Combined with the existing PRIMARY KEY on id, this
--    guarantees at most one row can ever exist in the table again: any row
--    must have id = 1, and id is unique.
--
-- The matching application-layer change (GovernanceService.getConfig(), see
-- the accompanying commit) switches the auto-provisioning path to an
-- explicit INSERT ... VALUES (1, ...) ON CONFLICT (id) DO NOTHING, so the
-- race is closed at both the app and the database layer. The GovernanceConfig
-- entity also declares this CHECK constraint directly so `synchronize: true`
-- (dev/test) schemas get the same guarantee without waiting on this file.
--
-- Run after 015_add_sensor_reading_replay_protection.sql

BEGIN;

-- ─── Step 1a: Materialize id = 1 if it's missing ──────────────────────────────
-- No-op if id = 1 already exists, or if the table is empty (nothing to
-- promote — GovernanceService.getConfig() will create it on first use).
INSERT INTO governance_config (
  id, protocol_fee_bps, min_oracle_confirmations, voting_period,
  timelock_period, quorum, ph_min, ph_max, do_threshold, temp_penalty_delta,
  weight_volumetric, weight_nitrogen, weight_phosphorus, updated_by, updated_at
)
SELECT
  1, protocol_fee_bps, min_oracle_confirmations, voting_period,
  timelock_period, quorum, ph_min, ph_max, do_threshold, temp_penalty_delta,
  weight_volumetric, weight_nitrogen, weight_phosphorus, updated_by, updated_at
FROM governance_config
WHERE NOT EXISTS (SELECT 1 FROM governance_config WHERE id = 1)
ORDER BY updated_at DESC, id ASC
LIMIT 1;

-- ─── Step 1b: Re-point audit history at the surviving singleton ──────────────
UPDATE governance_config_changes
SET config_id = 1
WHERE config_id <> 1;

-- ─── Step 1c: Delete every duplicate ──────────────────────────────────────────
-- Nothing still references them after the reparent above, so this is safe
-- under the existing FK (config_id ... ON DELETE CASCADE).
DELETE FROM governance_config WHERE id <> 1;

-- ─── Step 2: Enforce the singleton at the schema level ────────────────────────
-- Guarded so the migration can be safely re-run (matches the ADD VALUE guard
-- in migration 009).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'governance_config_singleton_id'
      AND conrelid = 'governance_config'::regclass
  ) THEN
    ALTER TABLE governance_config
      ADD CONSTRAINT governance_config_singleton_id CHECK (id = 1);
  END IF;
END$$;

-- Keep the id sequence from drifting into values that could never be used.
-- Cosmetic only — the application always inserts id = 1 explicitly — but it
-- keeps `\d governance_config` output from looking alarming post-migration.
SELECT setval(pg_get_serial_sequence('governance_config', 'id'), 1, true);

COMMIT;

COMMENT ON CONSTRAINT governance_config_singleton_id ON governance_config IS
  'Enforces the protocol config singleton: exactly one row (id = 1) may ever '
  'exist. See GovernanceService.getConfig() for the matching race-free '
  'INSERT ... ON CONFLICT (id) DO NOTHING upsert.';
