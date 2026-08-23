-- Migration 017: Oracle structured multi-parameter readings (issue #80)
--
-- Background
-- ----------
-- Prior to this change, oracle-processor.ts collapsed the full water-quality
-- snapshot (ph, turbidity, dissolved_oxygen, flow_rate, nitrogen, phosphorus,
-- temperature) into a single i128 by picking dissolved_oxygen → ph → 0.  This
-- meant:
--   1. Six of the seven parameters were silently discarded at the chain boundary.
--   2. A reading with no DO or pH was submitted as 0 — a falsified "clean water"
--      attestation.
--
-- What changed
-- ------------
-- The Soroban oracle contract's `submit_reading` method now accepts all seven
-- parameters as individual Option<i128> values.  The off-chain layer
-- (OracleReadingPayload) stores them in the existing `readings_snapshot` JSONB
-- column under the canonical camelCase field names:
--
--   { ph, turbidity, dissolvedOxygen, flowRate, nitrogen, phosphorus, temperature }
--
-- This migration:
--   1. Adds a CHECK constraint that every non-null readings_snapshot must contain
--      at least one of the seven recognised parameter keys with a non-null value,
--      preventing the "all-null / zero-fallback" scenario at the database level.
--   2. Adds a GIN index on readings_snapshot so per-parameter queries are fast.
--   3. Documents the expected schema in a table comment.
--
-- Backward compatibility
-- ----------------------
-- The column type (JSONB) and nullable contract are unchanged; existing rows that
-- already stored a partial snapshot (e.g. only {dissolvedOxygen:6.8}) pass the
-- new CHECK constraint because they have at least one recognised key.
-- Rows that were stored as {} (empty object) will fail the constraint on UPDATE
-- or INSERT — that is intentional: the application-level guard in
-- mapSnapshotToPayload() already prevents empty payloads from reaching the DB.

-- 1. Add a GIN index for fast JSONB parameter queries.
--    (CONCURRENTLY is safe here; it does not hold a full table lock.)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_oracle_submissions_snapshot_gin
    ON oracle_submissions USING gin (readings_snapshot);

-- 2. Add a CHECK constraint that rejects snapshots with no recognisable
--    numeric reading fields.  The expression evaluates to TRUE when any of the
--    seven canonical keys is present and not JSON null.
ALTER TABLE oracle_submissions
    ADD CONSTRAINT chk_oracle_readings_not_empty
    CHECK (
        (readings_snapshot -> 'ph')               IS NOT NULL AND (readings_snapshot ->> 'ph')               IS NOT NULL
        OR (readings_snapshot -> 'turbidity')      IS NOT NULL AND (readings_snapshot ->> 'turbidity')        IS NOT NULL
        OR (readings_snapshot -> 'dissolvedOxygen') IS NOT NULL AND (readings_snapshot ->> 'dissolvedOxygen') IS NOT NULL
        OR (readings_snapshot -> 'flowRate')       IS NOT NULL AND (readings_snapshot ->> 'flowRate')         IS NOT NULL
        OR (readings_snapshot -> 'nitrogen')       IS NOT NULL AND (readings_snapshot ->> 'nitrogen')         IS NOT NULL
        OR (readings_snapshot -> 'phosphorus')     IS NOT NULL AND (readings_snapshot ->> 'phosphorus')       IS NOT NULL
        OR (readings_snapshot -> 'temperature')    IS NOT NULL AND (readings_snapshot ->> 'temperature')      IS NOT NULL
    );

-- 3. Document the expected JSONB schema on the table and column.
COMMENT ON TABLE oracle_submissions IS
    'Off-chain record of every Soroban oracle submission.  '
    'readings_snapshot stores the full multi-parameter water-quality payload '
    'as submitted to the on-chain verification_oracle contract.';

COMMENT ON COLUMN oracle_submissions.readings_snapshot IS
    'Structured water-quality reading snapshot.  '
    'Expected keys (all optional but at least one must be non-null): '
    'ph (numeric), turbidity (numeric, NTU), dissolvedOxygen (numeric, mg/L), '
    'flowRate (numeric, m³/s), nitrogen (numeric, mg/L), '
    'phosphorus (numeric, mg/L), temperature (numeric, °C).  '
    'Values are stored as plain numbers; the Soroban contract receives them '
    'as Option<i128> scaled by 1 000 (3 dp fixed-point).';
