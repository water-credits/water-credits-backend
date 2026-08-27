import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { ThrottlerStorage } from '@nestjs/throttler';
import { Logger } from '@nestjs/common';
import { Namespace, Server, Socket } from 'socket.io';
import { SensorsGateway } from './sensors.gateway';
import { UserRole } from '../users/entities/user.entity';
import { SensorProjectAccessService } from './sensor-project-access.service';
import {
  WS_CONNECTION_THROTTLE,
  WS_SUBSCRIBE_THROTTLE,
} from '../../common/decorators/throttle.decorator';

interface MockRedisClient {
  connect: jest.Mock;
  ping: jest.Mock;
  duplicate: jest.Mock;
  on: jest.Mock;
  disconnect: jest.Mock;
  quit: jest.Mock;
}

let mockRedisConstructor: jest.Mock;
let mockCreateAdapter: jest.Mock;

jest.mock('ioredis', () => {
  function RedisCtor(options: unknown) {
    return mockRedisConstructor(options);
  }
  RedisCtor.default = RedisCtor;
  return RedisCtor;
});

jest.mock('@socket.io/redis-adapter', () => ({
  createAdapter: (...args: unknown[]) => mockCreateAdapter(...args),
}));

function mockRedisClient(): MockRedisClient {
  const client: MockRedisClient = {
    connect: jest.fn().mockResolvedValue(undefined),
    ping: jest.fn().mockResolvedValue('PONG'),
    duplicate: jest.fn(),
    on: jest.fn(),
    disconnect: jest.fn(),
    quit: jest.fn().mockResolvedValue('OK'),
  };
  client.on.mockReturnValue(client);
  return client;
}

function mockSocket(overrides: Partial<Socket> = {}): Socket {
  return {
    id: 'socket-1',
    handshake: { auth: {}, headers: {}, query: {}, address: '127.0.0.1' },
    data: {},
    rooms: new Set(['socket-1']),
    join: jest.fn(),
    leave: jest.fn(),
    emit: jest.fn(),
    disconnect: jest.fn(),
    ...overrides,
  } as unknown as Socket;
}

describe('SensorsGateway', () => {
  let gateway: SensorsGateway;
  let jwtService: { verifyAsync: jest.Mock };
  let projectAccess: { canAccessProject: jest.Mock };
  let configService: { get: jest.Mock };
  let throttlerStorage: { increment: jest.Mock };
  let pubClient: MockRedisClient;
  let subClient: MockRedisClient;

  beforeEach(() => {
    jwtService = { verifyAsync: jest.fn() };
    projectAccess = { canAccessProject: jest.fn() };
    configService = {
      get: jest.fn((key: string, defaultVal?: unknown) => {
        const values: Record<string, unknown> = {
          REDIS_HOST: 'localhost',
          REDIS_PORT: 6379,
          REDIS_PASSWORD: undefined,
          'sensor.wsRedisConnectTimeoutMs': 5000,
        };
        return key in values ? values[key] : defaultVal;
      }),
    };
    // Default: never throttled. Individual tests override this to simulate bursts.
    throttlerStorage = {
      increment: jest.fn().mockResolvedValue({ totalHits: 1, timeToExpire: 60 }),
    };
    pubClient = mockRedisClient();
    subClient = mockRedisClient();
    pubClient.duplicate.mockReturnValue(subClient);
    mockRedisConstructor = jest.fn().mockReturnValue(pubClient);
    mockCreateAdapter = jest.fn();
    gateway = new SensorsGateway(
      jwtService as unknown as JwtService,
      projectAccess as unknown as SensorProjectAccessService,
      configService as unknown as ConfigService,
      throttlerStorage as unknown as ThrottlerStorage,
    );
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('Redis adapter lifecycle', () => {
    function assignNamespace(): { namespace: Namespace; inProcessAdapter: object } {
      const inProcessAdapter = { kind: 'in-process' };
      const namespace = { adapter: inProcessAdapter } as unknown as Namespace;
      gateway.server = namespace;
      return { namespace, inProcessAdapter };
    }

    it('retains Socket.IO in-process mode when Redis is not configured', async () => {
      configService.get.mockImplementation((key: string, defaultVal?: unknown) =>
        key === 'REDIS_HOST' ? undefined : defaultVal,
      );
      const io = new Server();
      const namespace = io.of('/sensors');
      const inProcessAdapter = namespace.adapter;
      gateway.server = namespace;

      await expect(gateway.onModuleInit()).resolves.toBeUndefined();

      expect(namespace).toBeInstanceOf(Namespace);
      expect(namespace.adapter).toBe(inProcessAdapter);
      expect(mockRedisConstructor).not.toHaveBeenCalled();
      expect(mockCreateAdapter).not.toHaveBeenCalled();
    });

    it('attaches the Redis adapter only after both clients connect and answer PING', async () => {
      const { namespace } = assignNamespace();
      const redisAdapter = { kind: 'redis' };
      const adapterFactory = jest.fn().mockReturnValue(redisAdapter);
      mockCreateAdapter.mockReturnValue(adapterFactory);

      await gateway.onModuleInit();

      expect(pubClient.connect).toHaveBeenCalledTimes(1);
      expect(subClient.connect).toHaveBeenCalledTimes(1);
      expect(pubClient.ping).toHaveBeenCalledTimes(1);
      expect(subClient.ping).toHaveBeenCalledTimes(1);
      expect(mockCreateAdapter).toHaveBeenCalledWith(pubClient, subClient);
      expect(adapterFactory).toHaveBeenCalledWith(namespace);
      expect(namespace.adapter).toBe(redisAdapter);
      expect(pubClient.ping.mock.invocationCallOrder[0]).toBeLessThan(
        mockCreateAdapter.mock.invocationCallOrder[0],
      );
      expect(subClient.ping.mock.invocationCallOrder[0]).toBeLessThan(
        mockCreateAdapter.mock.invocationCallOrder[0],
      );
    });

    it('falls back without an unhandled rejection when Redis connection fails', async () => {
      const { namespace, inProcessAdapter } = assignNamespace();
      const connectionError = new Error('connect ECONNREFUSED');
      pubClient.connect.mockRejectedValue(connectionError);
      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      const unhandledRejection = jest.fn();
      process.on('unhandledRejection', unhandledRejection);

      try {
        await expect(gateway.onModuleInit()).resolves.toBeUndefined();
        await new Promise<void>((resolve) => setImmediate(resolve));

        expect(namespace.adapter).toBe(inProcessAdapter);
        expect(mockCreateAdapter).not.toHaveBeenCalled();
        expect(pubClient.disconnect).toHaveBeenCalledTimes(1);
        expect(subClient.disconnect).toHaveBeenCalledTimes(1);
        expect(warnSpy).toHaveBeenCalledWith('SensorsGateway falling back to in-process adapter');
        expect(unhandledRejection).not.toHaveBeenCalled();
      } finally {
        process.off('unhandledRejection', unhandledRejection);
      }
    });

    it('falls back after the default five-second timeout when connection hangs', async () => {
      jest.useFakeTimers();
      const { namespace, inProcessAdapter } = assignNamespace();
      const pendingConnection = new Promise<void>(() => undefined);
      pubClient.connect.mockReturnValue(pendingConnection);
      subClient.connect.mockReturnValue(pendingConnection);
      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();

      const initialization = gateway.onModuleInit();
      await jest.advanceTimersByTimeAsync(4_999);
      expect(pubClient.disconnect).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(1);
      await expect(initialization).resolves.toBeUndefined();

      expect(namespace.adapter).toBe(inProcessAdapter);
      expect(pubClient.disconnect).toHaveBeenCalledTimes(1);
      expect(subClient.disconnect).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith('SensorsGateway falling back to in-process adapter');
    });

    it('honours a custom Redis connection timeout', async () => {
      jest.useFakeTimers();
      configService.get.mockImplementation((key: string, defaultVal?: unknown) => {
        const values: Record<string, unknown> = {
          REDIS_HOST: 'localhost',
          REDIS_PORT: 6379,
          REDIS_PASSWORD: undefined,
          'sensor.wsRedisConnectTimeoutMs': 25,
        };
        return key in values ? values[key] : defaultVal;
      });
      assignNamespace();
      const pendingConnection = new Promise<void>(() => undefined);
      pubClient.connect.mockReturnValue(pendingConnection);
      subClient.connect.mockReturnValue(pendingConnection);
      jest.spyOn(Logger.prototype, 'warn').mockImplementation();

      const initialization = gateway.onModuleInit();
      await jest.advanceTimersByTimeAsync(24);
      expect(pubClient.disconnect).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(1);
      await initialization;

      expect(pubClient.disconnect).toHaveBeenCalledTimes(1);
      expect(mockRedisConstructor).toHaveBeenCalledWith(
        expect.objectContaining({ connectTimeout: 25 }),
      );
    });

    it('defaults a timeout that exceeds the Node.js timer limit', async () => {
      configService.get.mockImplementation((key: string, defaultVal?: unknown) => {
        const values: Record<string, unknown> = {
          REDIS_HOST: 'localhost',
          REDIS_PORT: 6379,
          REDIS_PASSWORD: undefined,
          'sensor.wsRedisConnectTimeoutMs': 2_147_483_648,
        };
        return key in values ? values[key] : defaultVal;
      });
      assignNamespace();
      mockCreateAdapter.mockReturnValue(jest.fn().mockReturnValue({ kind: 'redis' }));

      await gateway.onModuleInit();

      expect(mockRedisConstructor).toHaveBeenCalledWith(
        expect.objectContaining({ connectTimeout: 5000 }),
      );
    });

    it('registers structured error listeners before connecting', async () => {
      assignNamespace();
      mockCreateAdapter.mockReturnValue(jest.fn().mockReturnValue({ kind: 'redis' }));
      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();

      await gateway.onModuleInit();

      expect(pubClient.on).toHaveBeenCalledWith('error', expect.any(Function));
      expect(subClient.on).toHaveBeenCalledWith('error', expect.any(Function));
      expect(pubClient.on.mock.invocationCallOrder[0]).toBeLessThan(
        pubClient.connect.mock.invocationCallOrder[0],
      );
      expect(subClient.on.mock.invocationCallOrder[0]).toBeLessThan(
        subClient.connect.mock.invocationCallOrder[0],
      );

      const publisherErrorHandler = pubClient.on.mock.calls.find(
        ([event]) => event === 'error',
      )?.[1] as ((error: Error) => void) | undefined;
      const redisError = Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
      publisherErrorHandler?.(redisError);

      expect(warnSpy).toHaveBeenCalledWith({
        message: 'SensorsGateway Redis client error',
        client: 'publisher',
        error: {
          name: 'Error',
          message: 'connection reset',
          code: 'ECONNRESET',
        },
      });
    });

    it('uses bounded exponential backoff with jitter for reconnects', async () => {
      assignNamespace();
      mockCreateAdapter.mockReturnValue(jest.fn().mockReturnValue({ kind: 'redis' }));
      jest.spyOn(Math, 'random').mockReturnValue(0.5);

      await gateway.onModuleInit();

      const options = mockRedisConstructor.mock.calls[0][0] as {
        lazyConnect: boolean;
        retryStrategy: (attempt: number) => number;
      };
      expect(options.lazyConnect).toBe(true);
      expect(options.retryStrategy(1)).toBe(150);
      expect(options.retryStrategy(2)).toBe(200);
      expect(options.retryStrategy(20)).toBe(5_100);
    });

    it('shuts down safely before initialization and remains idempotent after success', async () => {
      await expect(gateway.onModuleDestroy()).resolves.toBeUndefined();
      expect(pubClient.quit).not.toHaveBeenCalled();
      expect(subClient.quit).not.toHaveBeenCalled();

      assignNamespace();
      mockCreateAdapter.mockReturnValue(jest.fn().mockReturnValue({ kind: 'redis' }));
      await gateway.onModuleInit();

      await expect(gateway.onModuleDestroy()).resolves.toBeUndefined();
      await expect(gateway.onModuleDestroy()).resolves.toBeUndefined();

      expect(pubClient.quit).toHaveBeenCalledTimes(1);
      expect(subClient.quit).toHaveBeenCalledTimes(1);
    });
  });

  describe('handleConnection', () => {
    it('accepts a client with a valid token', async () => {
      jwtService.verifyAsync.mockResolvedValue({
        sub: 'user-1',
        wallet: 'G...',
        role: UserRole.FARMER,
      });
      const client = mockSocket({
        handshake: { auth: { token: 'valid.jwt' }, headers: {}, query: {} } as never,
      });

      await gateway.handleConnection(client);

      expect(client.data.userId).toBe('user-1');
      expect(client.disconnect).not.toHaveBeenCalled();
    });

    it('disconnects a client with no token (CORS wildcard alone is not authentication)', async () => {
      const client = mockSocket();

      await gateway.handleConnection(client);

      expect(client.disconnect).toHaveBeenCalledWith(true);
    });

    it('disconnects a client with an invalid token', async () => {
      jwtService.verifyAsync.mockRejectedValue(new Error('invalid signature'));
      const client = mockSocket({
        handshake: { auth: { token: 'bad.jwt' }, headers: {}, query: {} } as never,
      });

      await gateway.handleConnection(client);

      expect(client.disconnect).toHaveBeenCalledWith(true);
    });
  });

  describe('handleSubscribeProject', () => {
    async function connectedClient(userId: string, role: string): Promise<Socket> {
      jwtService.verifyAsync.mockResolvedValue({ sub: userId, wallet: 'G...', role });
      const client = mockSocket({
        handshake: { auth: { token: 't' }, headers: {}, query: {} } as never,
      });
      await gateway.handleConnection(client);
      return client;
    }

    it('allows the project owner to subscribe', async () => {
      projectAccess.canAccessProject.mockResolvedValue(true);
      const client = await connectedClient('user-1', UserRole.FARMER);

      await gateway.handleSubscribeProject(client, 'p1');

      expect(client.join).toHaveBeenCalledWith('project:p1');
      expect(client.emit).not.toHaveBeenCalledWith('error', expect.anything());
    });

    it('denies a non-owner farmer from subscribing', async () => {
      projectAccess.canAccessProject.mockResolvedValue(false);
      const client = await connectedClient('user-1', UserRole.FARMER);

      await gateway.handleSubscribeProject(client, 'p1');

      expect(client.join).not.toHaveBeenCalled();
      expect(client.emit).toHaveBeenCalledWith(
        'error',
        expect.objectContaining({ message: expect.any(String) }),
      );
    });

    it('allows privileged roles (admin/verifier/oracle) regardless of ownership', async () => {
      projectAccess.canAccessProject.mockResolvedValue(true);
      const client = await connectedClient('admin-1', UserRole.ADMIN);

      await gateway.handleSubscribeProject(client, 'p1');

      expect(projectAccess.canAccessProject).toHaveBeenCalledWith('admin-1', UserRole.ADMIN, 'p1');
      expect(client.join).toHaveBeenCalledWith('project:p1');
    });

    it('denies subscription when the project does not exist', async () => {
      projectAccess.canAccessProject.mockResolvedValue(false);
      const client = await connectedClient('user-1', UserRole.FARMER);

      await gateway.handleSubscribeProject(client, 'missing-project');

      expect(client.join).not.toHaveBeenCalled();
      expect(client.emit).toHaveBeenCalledWith('error', expect.anything());
    });

    it('denies subscription for a client that never authenticated', async () => {
      const client = mockSocket();

      await gateway.handleSubscribeProject(client, 'p1');

      expect(client.join).not.toHaveBeenCalled();
      expect(client.emit).toHaveBeenCalledWith('error', expect.anything());
    });
  });

  describe('connection rate limiting', () => {
    it('rejects a connection once the per-IP limit is exceeded', async () => {
      throttlerStorage.increment.mockResolvedValue({
        totalHits: WS_CONNECTION_THROTTLE.limit + 1,
        timeToExpire: 60,
      });
      jwtService.verifyAsync.mockResolvedValue({
        sub: 'user-1',
        wallet: 'G...',
        role: UserRole.FARMER,
      });
      const client = mockSocket({
        handshake: {
          auth: { token: 'valid.jwt' },
          headers: {},
          query: {},
          address: '10.0.0.1',
        } as never,
      });

      await gateway.handleConnection(client);

      expect(client.disconnect).toHaveBeenCalledWith(true);
      expect(client.emit).toHaveBeenCalledWith(
        'error',
        expect.objectContaining({
          message: expect.stringContaining('Too many connection attempts'),
        }),
      );
      // Throttling is checked before token verification.
      expect(jwtService.verifyAsync).not.toHaveBeenCalled();
    });

    it('tracks connection attempts per client IP', async () => {
      jwtService.verifyAsync.mockResolvedValue({
        sub: 'user-1',
        wallet: 'G...',
        role: UserRole.FARMER,
      });
      const client = mockSocket({
        handshake: {
          auth: { token: 'valid.jwt' },
          headers: {},
          query: {},
          address: '10.0.0.2',
        } as never,
      });

      await gateway.handleConnection(client);

      expect(throttlerStorage.increment).toHaveBeenCalledWith(
        'ws:sensors:connect:10.0.0.2',
        WS_CONNECTION_THROTTLE.ttl,
      );
    });
  });

  describe('subscribe/unsubscribe rate limiting', () => {
    async function connectedClient(userId: string, role: string): Promise<Socket> {
      jwtService.verifyAsync.mockResolvedValue({ sub: userId, wallet: 'G...', role });
      const client = mockSocket({
        handshake: { auth: { token: 't' }, headers: {}, query: {} } as never,
      });
      await gateway.handleConnection(client);
      return client;
    }

    it('rejects subscribe:project once the per-client limit is exceeded', async () => {
      const client = await connectedClient('user-1', UserRole.FARMER);
      throttlerStorage.increment.mockResolvedValue({
        totalHits: WS_SUBSCRIBE_THROTTLE.limit + 1,
        timeToExpire: 60,
      });

      await gateway.handleSubscribeProject(client, 'p1');

      expect(projectAccess.canAccessProject).not.toHaveBeenCalled();
      expect(client.join).not.toHaveBeenCalled();
      expect(client.emit).toHaveBeenCalledWith(
        'error',
        expect.objectContaining({
          message: expect.stringContaining('Too many subscription requests'),
        }),
      );
    });

    it('rejects unsubscribe:project once the per-client limit is exceeded', async () => {
      const client = await connectedClient('user-1', UserRole.FARMER);
      throttlerStorage.increment.mockResolvedValue({
        totalHits: WS_SUBSCRIBE_THROTTLE.limit + 1,
        timeToExpire: 60,
      });

      await gateway.handleUnsubscribeProject(client, 'p1');

      expect(client.leave).not.toHaveBeenCalled();
      expect(client.emit).toHaveBeenCalledWith(
        'error',
        expect.objectContaining({
          message: expect.stringContaining('Too many subscription requests'),
        }),
      );
    });

    it('shares one counter between subscribe and unsubscribe for the same client', async () => {
      const client = await connectedClient('user-1', UserRole.FARMER);
      projectAccess.canAccessProject.mockResolvedValue(true);

      await gateway.handleSubscribeProject(client, 'p1');
      await gateway.handleUnsubscribeProject(client, 'p1');

      expect(throttlerStorage.increment).toHaveBeenNthCalledWith(
        2,
        'ws:sensors:subscribe:user-1',
        WS_SUBSCRIBE_THROTTLE.ttl,
      );
      expect(throttlerStorage.increment).toHaveBeenNthCalledWith(
        3,
        'ws:sensors:subscribe:user-1',
        WS_SUBSCRIBE_THROTTLE.ttl,
      );
    });
  });
});
