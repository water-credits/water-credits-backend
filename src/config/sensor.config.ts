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
}));
