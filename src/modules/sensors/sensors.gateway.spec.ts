import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { ThrottlerStorage } from '@nestjs/throttler';
import { Socket } from 'socket.io';
import { SensorsGateway } from './sensors.gateway';
import { UserRole } from '../users/entities/user.entity';
import { SensorProjectAccessService } from './sensor-project-access.service';
import {
  WS_CONNECTION_THROTTLE,
  WS_SUBSCRIBE_THROTTLE,
} from '../../common/decorators/throttle.decorator';

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

  beforeEach(() => {
    jwtService = { verifyAsync: jest.fn() };
    projectAccess = { canAccessProject: jest.fn() };
    configService = {
      get: jest.fn((key: string, defaultVal?: unknown) => {
        const values: Record<string, unknown> = {
          REDIS_HOST: 'localhost',
          REDIS_PORT: 6379,
          REDIS_PASSWORD: undefined,
        };
        return key in values ? values[key] : defaultVal;
      }),
    };
    // Default: never throttled. Individual tests override this to simulate bursts.
    throttlerStorage = {
      increment: jest.fn().mockResolvedValue({ totalHits: 1, timeToExpire: 60 }),
    };
    gateway = new SensorsGateway(
      jwtService as unknown as JwtService,
      projectAccess as unknown as SensorProjectAccessService,
      configService as unknown as ConfigService,
      throttlerStorage as unknown as ThrottlerStorage,
    );
    // afterInit is NOT called in unit tests — Redis clients are never created.
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
