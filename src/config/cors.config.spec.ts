import { SensorsGateway } from '../modules/sensors/sensors.gateway';
import { corsOptions, resolveCorsOrigin } from './cors.config';

// Matches @nestjs/websockets' internal GATEWAY_OPTIONS metadata key. Not
// part of the package's public exports, but stable across the 10.x line.
const GATEWAY_OPTIONS_METADATA = 'websockets:gateway_options';

describe('cors config', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalCorsOrigin = process.env.CORS_ORIGIN;

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    process.env.CORS_ORIGIN = originalCorsOrigin;
  });

  it('allows any origin outside production', () => {
    process.env.NODE_ENV = 'development';
    expect(resolveCorsOrigin()).toBe('*');
  });

  it('restricts to CORS_ORIGIN in production', () => {
    process.env.NODE_ENV = 'production';
    process.env.CORS_ORIGIN = 'https://app.water-credits.example';
    expect(resolveCorsOrigin()).toBe('https://app.water-credits.example');
  });

  it('is the exact object SensorsGateway registers as its WS CORS policy', () => {
    // Guards against the HTTP (main.ts) and WS (SensorsGateway) CORS
    // policies drifting apart by re-declaring their own copies.
    const gatewayOptions = Reflect.getMetadata(GATEWAY_OPTIONS_METADATA, SensorsGateway) as {
      cors: unknown;
    };

    expect(gatewayOptions.cors).toBe(corsOptions);
  });
});
