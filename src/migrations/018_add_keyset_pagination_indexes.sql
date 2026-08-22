-- Migration 018: Composite indexes for keyset (cursor) pagination (issue #90)
--
-- Background
-- ----------
-- The high-volume list endpoints (sensor readings, oracle submissions,
-- retirements, proposals, notifications, users) paginated exclusively with
-- OFFSET/LIMIT.  Under the concurrent write rates this platform expects,
-- OFFSET pagination silently duplicates or skips rows as new inserts shift the
-- offset between page fetches, and it degrades to O(offset) on large tables.
--
-- These endpoints now support keyset (a.k.a. seek) pagination that seeks past
-- an opaque (sortValue, id) cursor:
--
--     WHERE (sort_col < :v OR (sort_col = :v AND id < :id))   -- newest-first
--     ORDER BY sort_col DESC, id DESC
--     LIMIT :limit + 1
--
-- For that predicate + ORDER BY to resolve as a single index range scan (rather
-- than a full sort), PostgreSQL needs a composite btree on (sort_col, id) —
-- optionally prefixed by the column the endpoint filters on.  A btree defined
-- ASC is scanned backwards for the DESC queries, so no explicit DESC index is
-- required.  These indexes also accelerate the legacy OFFSET path, whose
-- ordering now carries the same `id` tiebreaker.
--
-- Notes
-- -----
--   * CREATE INDEX CONCURRENTLY avoids holding a write lock on these hot tables
--     while the index builds; it cannot run inside a transaction block.
--   * IF NOT EXISTS makes the migration idempotent and keeps it consistent with
--     the schema the TypeORM entity @Index decorators generate in development
--     (where synchronize is enabled).

-- ── sensor_readings — keyset (timestamp, id), plus filtered variants ─────────
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sensor_readings_timestamp_id
    ON sensor_readings (timestamp, id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sensor_readings_project_timestamp_id
    ON sensor_readings (project_id, timestamp, id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sensor_readings_device_timestamp_id
    ON sensor_readings (device_id, timestamp, id);

-- ── oracle_submissions — keyset (created_at, id), plus filtered variants ─────
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_oracle_submissions_created_at_id
    ON oracle_submissions (created_at, id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_oracle_submissions_project_created_at_id
    ON oracle_submissions (project_id, created_at, id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_oracle_submissions_status_created_at_id
    ON oracle_submissions (status, created_at, id);

-- ── retirements — always scoped to user_id ──────────────────────────────────
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_retirements_user_retired_at_id
    ON retirements (user_id, retired_at, id);

-- ── proposals — keyset (created_at, id), plus status filter variant ──────────
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_proposals_created_at_id
    ON proposals (created_at, id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_proposals_status_created_at_id
    ON proposals (status, created_at, id);

-- ── notifications — always scoped to user_id ────────────────────────────────
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_notifications_user_created_at_id
    ON notifications (user_id, created_at, id);

-- ── users — keyset (created_at, id) ─────────────────────────────────────────
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_users_created_at_id
    ON users (created_at, id);
