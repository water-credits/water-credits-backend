import sensorConfig, { DEFAULT_WS_REDIS_CONNECT_TIMEOUT_MS } from './sensor.config';

describe('sensorConfig', () => {
  const originalTimeout = process.env.WS_REDIS_CONNECT_TIMEOUT_MS;

  afterEach(() => {
    if (originalTimeout === undefined) {
      delete process.env.WS_REDIS_CONNECT_TIMEOUT_MS;
    } else {
      process.env.WS_REDIS_CONNECT_TIMEOUT_MS = originalTimeout;
    }
  });

  it('defaults the WebSocket Redis connection timeout to five seconds', () => {
    delete process.env.WS_REDIS_CONNECT_TIMEOUT_MS;

    expect(sensorConfig().wsRedisConnectTimeoutMs).toBe(DEFAULT_WS_REDIS_CONNECT_TIMEOUT_MS);
  });

  it('accepts a positive WebSocket Redis connection timeout', () => {
    process.env.WS_REDIS_CONNECT_TIMEOUT_MS = '2750';

    expect(sensorConfig().wsRedisConnectTimeoutMs).toBe(2750);
  });

  it.each(['0', '-1', '1.5', '100ms', '2147483648', 'invalid'])(
    'rejects invalid timeout value %s',
    (value) => {
      process.env.WS_REDIS_CONNECT_TIMEOUT_MS = value;

      expect(sensorConfig().wsRedisConnectTimeoutMs).toBe(DEFAULT_WS_REDIS_CONNECT_TIMEOUT_MS);
    },
  );
});
