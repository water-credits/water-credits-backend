import { registerAs } from '@nestjs/config';

/**
 * Maximum age of a sensor reading (in seconds) before rejection.
 * Default: 24 hours. This prevents acceptance of readings from stalled devices.
 */
export const DEFAULT_SENSOR_MAX_AGE_SECONDS = 24 * 60 * 60;

/**
 * Maximum future offset for sensor readings (in seconds).
 * Default: 5 minutes. Allows for minor clock skew between sensor and server.
 */
export const DEFAULT_SENSOR_FUTURE_OFFSET_SECONDS = 5 * 60;

/**
 * How long a device can go without a reading before it is considered stale
 * (minutes). Default: 60 minutes.
 */
export const DEFAULT_SENSOR_STALE_AFTER_MINUTES = 60;

/**
 * Minimum time between two `sensor:alert` notifications for the same
 * device+parameter+direction (milliseconds). Prevents alert storms when a
 * value hovers around a threshold or a device stays stale across many cron
 * ticks. Default: 15 minutes.
 */
export const DEFAULT_SENSOR_ALERT_DEBOUNCE_MS = 15 * 60 * 1000;

/**
 * Maximum time to wait for the SensorsGateway Redis pub/sub clients to become
 * ready before retaining Socket.IO's in-process adapter. Default: 5 seconds.
 */
export const DEFAULT_WS_REDIS_CONNECT_TIMEOUT_MS = 5_000;
/** Largest delay accepted by Node.js setTimeout without overflowing to 1 ms. */
export const MAX_WS_REDIS_CONNECT_TIMEOUT_MS = 2_147_483_647;

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= MAX_WS_REDIS_CONNECT_TIMEOUT_MS
    ? parsed
    : fallback;
}

export default registerAs('sensor', () => ({
  /**
   * Maximum age of a sensor reading (seconds) before rejection.
   */
  maxAgeSeconds: parseInt(
    process.env.SENSOR_MAX_AGE_SECONDS || `${DEFAULT_SENSOR_MAX_AGE_SECONDS}`,
    10,
  ),
  /**
   * Maximum future offset for sensor readings (seconds) to allow for clock skew.
   */
  futureOffsetSeconds: parseInt(
    process.env.SENSOR_FUTURE_OFFSET_SECONDS || `${DEFAULT_SENSOR_FUTURE_OFFSET_SECONDS}`,
    10,
  ),
  /**
   * Minutes of silence from an active device before it is flagged stale.
   */
  staleAfterMinutes: parseInt(
    process.env.SENSOR_STALE_AFTER_MINUTES || `${DEFAULT_SENSOR_STALE_AFTER_MINUTES}`,
    10,
  ),
  /**
   * Debounce window (ms) shared by threshold-breach and staleness alerts.
   */
  alertDebounceMs: parseInt(
    process.env.SENSOR_ALERT_DEBOUNCE_MS || `${DEFAULT_SENSOR_ALERT_DEBOUNCE_MS}`,
    10,
  ),
  /**
   * Time allowed for both WebSocket Redis clients to connect and answer PING.
   */
  wsRedisConnectTimeoutMs: parsePositiveInteger(
    process.env.WS_REDIS_CONNECT_TIMEOUT_MS,
    DEFAULT_WS_REDIS_CONNECT_TIMEOUT_MS,
  ),
}));
