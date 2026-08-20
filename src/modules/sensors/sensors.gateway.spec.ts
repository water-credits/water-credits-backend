import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Socket } from 'socket.io';
import { SensorsGateway } from './sensors.gateway';
import { UserRole } from '../users/entities/user.entity';
import { SensorProjectAccessService } from './sensor-project-access.service';

function mockSocket(overrides: Partial<Socket> = {}): Socket {
  return {
    id: 'socket-1',
    handshake: { auth: {}, headers: {}, query: {} },
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
    gateway = new SensorsGateway(
      jwtService as unknown as JwtService,
      projectAccess as unknown as SensorProjectAccessService,
      configService as unknown as ConfigService,
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
});
