-- Migration 020: Percentage-of-eligible-voters quorum (issue: governance quorum model)
--
-- Background
-- ----------
-- governance_config.quorum was an absolute integer: "N votes decides a proposal"
-- regardless of how many people were eligible to vote. A proposal could pass
-- with 3 votes whether there were 4 eligible voters or 4000, which makes the
-- governance outcome trivially manipulable and economically unsound.
--
-- What changed
-- ------------
-- Quorum is now expressed as a share of the eligible-voter population (active,
-- KYC-verified users). This migration adds quorum_basis_points, stored in basis
-- points so the threshold is exact and integer-only (10000 = 100%). The default
-- 2000 = 20% turnout.
--
-- A proposal reaches quorum when turnout (votes_for + votes_against) is at least
-- quorum_basis_points / 10000 of the eligible population at evaluation time.
--
-- Backward compatibility
-- ----------------------
-- The legacy `quorum` integer column is intentionally retained, not dropped.
-- GovernanceService falls back to it as an absolute threshold in two cases:
--   1. quorum_basis_points = 0        (percentage model explicitly disabled), or
--   2. the eligible-voter count is 0  (bootstrap period, no denominator yet).
-- This keeps existing behaviour working during the migration window and avoids a
-- divide-by-zero at genesis.
--
-- SMALLINT (max 32767) comfortably holds the 0..10000 basis-point range.

ALTER TABLE governance_config
    ADD COLUMN IF NOT EXISTS quorum_basis_points SMALLINT NOT NULL DEFAULT 2000;

-- Keep the value within the valid basis-point range at the database level.
ALTER TABLE governance_config
    DROP CONSTRAINT IF EXISTS chk_governance_quorum_basis_points_range;
ALTER TABLE governance_config
    ADD CONSTRAINT chk_governance_quorum_basis_points_range
    CHECK (quorum_basis_points BETWEEN 0 AND 10000);

COMMENT ON COLUMN governance_config.quorum_basis_points IS
    'Percentage-of-eligible-voters quorum in basis points (10000 = 100%). '
    'Turnout (votes_for + votes_against) must reach this share of active, '
    'KYC-verified users for a proposal to be decided. 0 disables the '
    'percentage model and falls back to the absolute quorum column.';

COMMENT ON COLUMN governance_config.quorum IS
    'Legacy absolute vote-count quorum. Used only as a fallback when '
    'quorum_basis_points = 0 or the eligible-voter population is 0 (bootstrap).';
