-- Add composite index on (project_id, timestamp) for time-series queries
-- This index significantly improves performance for queries filtering by project_id and timestamp
-- which is the primary access pattern for the new time-series endpoint
CREATE INDEX idx_sensor_readings_project_timestamp ON sensor_readings (project_id, timestamp);
