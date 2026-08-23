-- Issue #72: Add replay protection to sensor readings
-- Prevents duplicate readings from being accepted multiple times by enforcing
-- a unique constraint on the combination of device_id, timestamp, and signature.

ALTER TABLE sensor_readings
ADD CONSTRAINT idx_device_timestamp_signature_unique
UNIQUE (device_id, timestamp, signature);

-- Comment explaining the constraint
COMMENT ON CONSTRAINT idx_device_timestamp_signature_unique ON sensor_readings IS
'Replay protection: prevents duplicate sensor readings. A reading is uniquely identified by (device_id, timestamp, signature).';
