-- Migration: 014_create_user_audit_log
-- Adds an append-only audit trail for admin actions on user accounts
-- (role changes, deactivation, restoration) per Issue #77.
--
-- Run after 013_add_sensor_reading_ws_emitted_at.sql

CREATE TABLE IF NOT EXISTS user_audit_log (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- e.g. 'role_changed', 'user_deactivated', 'user_restored'
  event_type       VARCHAR(50) NOT NULL,

  -- Admin who performed the action.
  actor_user_id    UUID NOT NULL REFERENCES users(id),

  -- User whose role/active state was changed.
  target_user_id   UUID NOT NULL REFERENCES users(id),

  -- Event-specific details, e.g. { "previousRole": "farmer", "newRole": "admin" }.
  payload          JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_audit_log_target ON user_audit_log (target_user_id);
CREATE INDEX IF NOT EXISTS idx_user_audit_log_actor  ON user_audit_log (actor_user_id);
CREATE INDEX IF NOT EXISTS idx_user_audit_log_created ON user_audit_log (created_at DESC);

COMMENT ON TABLE user_audit_log IS
  'Immutable audit log for admin-initiated changes to user role/active state.';
