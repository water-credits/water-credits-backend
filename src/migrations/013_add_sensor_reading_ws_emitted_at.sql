-- Migration: 013_add_sensor_reading_ws_emitted_at
-- Adds ws_emitted_at to sensor_readings to make the WebSocket fan-out of the
-- sensor-ingestion queue idempotent.
--
-- Background
-- ----------
-- SensorsIngestionProcessor broadcasts every saved reading to the project's
-- WebSocket room (sensor:reading) and emits threshold-breach alerts
-- (sensor:alert).  Bull retries failed jobs (default 5 attempts, exponential
-- backoff); without a durable "already emitted" marker a retry would re-emit
-- the same events to connected clients.
--
-- Fix: stamp ws_emitted_at on the reading once the processor has finished
-- emitting.  On retry the processor skips readings whose ws_emitted_at is set.
--
-- Run after 012_sensor_batch_unique_pending.sql

ALTER TABLE sensor_readings
  ADD COLUMN IF NOT EXISTS ws_emitted_at TIMESTAMPTZ;

COMMENT ON COLUMN sensor_readings.ws_emitted_at IS
  'Set by SensorsIngestionProcessor once sensor:reading/sensor:alert events '
  'have been emitted for this reading; used as an idempotency guard so Bull '
  'retries do not double-emit.';
