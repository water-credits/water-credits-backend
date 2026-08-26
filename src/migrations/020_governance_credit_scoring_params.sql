-- Migration: 020_governance_credit_scoring_params
-- Adds configurable credit-scoring parameters to the governance_config table.
--
-- The credit scoring formula in CreditScoringService.calculate() previously relied
-- on hardcoded placeholder constants (phPenaltyFactor, tempPenaltyFactor, nutrient
-- divisor). These columns let governance configure them.  Existing rows keep their
-- current behaviour because the defaults below match the old hardcoded values.
--
-- Idempotent: guarded with IF NOT EXISTS so re-runs are safe (matches the ADD
-- COLUMN convention in migration 006_governance_enhancements.sql).

-- UP MIGRATION
BEGIN;

ALTER TABLE governance_config
  ADD COLUMN IF NOT EXISTS ph_penalty_factor    NUMERIC(5,2) NOT NULL DEFAULT 1.00,
  ADD COLUMN IF NOT EXISTS temp_penalty_factor  NUMERIC(5,2) NOT NULL DEFAULT 1.00,
  ADD COLUMN IF NOT EXISTS nutrient_divisor     NUMERIC(5,2) NOT NULL DEFAULT 10.00;

COMMIT;

-- DOWN MIGRATION
BEGIN;

ALTER TABLE governance_config
  DROP COLUMN IF EXISTS ph_penalty_factor,
  DROP COLUMN IF EXISTS temp_penalty_factor,
  DROP COLUMN IF EXISTS nutrient_divisor;

COMMIT;
