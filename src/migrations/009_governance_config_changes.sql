-- Migration: 009_governance_config_changes
-- Implements the two-phase config update flow described in Issue #34.
--
-- 1. governance_config_changes  — pending / applied / cancelled change records
-- 2. SUPER_ADMIN role added to users table enum
-- 3. governance_events table already exists from 006; we just ensure the new
--    event_type values are documented via a comment.
--
-- Run after 008_nullify_refresh_tokens.sql

-- ─── 1. Add SUPER_ADMIN to the users role enum ────────────────────────────────
-- ALTER TYPE ... ADD VALUE is non-transactional in Postgres, so it must run
-- outside a transaction block (or as the only DDL in its own migration).
-- Using DO $$ to check first avoids duplicate-value errors on re-runs.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum
    WHERE enumtypid = 'user_role'::regtype
      AND enumlabel  = 'super_admin'
  ) THEN
    ALTER TYPE user_role ADD VALUE 'super_admin';
  END IF;
END$$;

-- ─── 2. governance_config_changes ─────────────────────────────────────────────
-- Stores each proposed config update until effectiveAt is reached, at which
-- point a scheduled job copies the values into the live governance_config row.

CREATE TABLE IF NOT EXISTS governance_config_changes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Foreign key to the governance_config row being modified.
  -- ON DELETE CASCADE: if the config row is somehow deleted, clean up the queue.
  config_id       INT NOT NULL REFERENCES governance_config(id) ON DELETE CASCADE,

  -- The new values being proposed. Stored as JSONB so the schema stays
  -- flexible as governance_config gains or loses columns over time.
  -- Example: { "protocolFeeBps": 150, "minOracleConfirmations": 4 }
  proposed_values JSONB NOT NULL,

  -- Stellar wallet address of the admin who submitted this change.
  proposed_by     VARCHAR(56) NOT NULL,

  -- When the change becomes eligible to be applied (NOW() + timelockPeriod).
  effective_at    TIMESTAMPTZ NOT NULL,

  -- Lifecycle state.
  -- pending   → waiting for effective_at to pass
  -- applied   → values written to governance_config
  -- cancelled → admin cancelled before effective_at
  -- emergency → applied immediately via emergency override (bypasses timelock)
  status          VARCHAR(20) NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'applied', 'cancelled', 'emergency')),

  -- Set when status transitions to 'applied' or 'emergency'.
  applied_at      TIMESTAMPTZ,
  applied_by      VARCHAR(56),

  -- Set when status transitions to 'cancelled'.
  cancelled_at    TIMESTAMPTZ,
  cancelled_by    VARCHAR(56),

  -- Optional human-readable reason supplied by the proposer.
  reason          TEXT,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes that the scheduled job and pending-list query rely on.
CREATE INDEX IF NOT EXISTS idx_gcc_status_effective
  ON governance_config_changes (status, effective_at);

CREATE INDEX IF NOT EXISTS idx_gcc_proposed_by
  ON governance_config_changes (proposed_by);

CREATE INDEX IF NOT EXISTS idx_gcc_config_id
  ON governance_config_changes (config_id);

-- ─── 3. Document new governance_events event_type values ─────────────────────
-- The governance_events table was created in 006; no schema change is needed.
-- The new event_type values used by the service are:
--   'config_change_proposed'    – PATCH /governance/config called
--   'config_change_applied'     – scheduler applied a pending change
--   'config_change_cancelled'   – admin cancelled a pending change
--   'config_emergency_updated'  – SUPER_ADMIN force-applied a change immediately
COMMENT ON TABLE governance_events IS
  'Immutable audit log. '
  'config-related event_type values: config_change_proposed, config_change_applied, '
  'config_change_cancelled, config_emergency_updated.';
