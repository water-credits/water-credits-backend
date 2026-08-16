import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Socket } from 'socket.io';
import { NotificationsGateway } from './notifications.gateway';

function mockSocket(overrides: Partial<Socket> = {}): Socket {
  return {
    id: 'socket-1',
    handshake: { auth: {}, headers: {}, query: {} },
    data: {},
    join: jest.fn(),
    disconnect: jest.fn(),
    ...overrides,
  } as unknown as Socket;
}

describe('NotificationsGateway', () => {
  let gateway: NotificationsGateway;
  let jwtService: { verifyAsync: jest.Mock };
  let configService: { get: jest.Mock };

  beforeEach(() => {
    jwtService = { verifyAsync: jest.fn() };
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
    gateway = new NotificationsGateway(
      jwtService as unknown as JwtService,
      configService as unknown as ConfigService,
    );
    // afterInit is NOT called in unit tests — Redis clients are never created.
    // Tests that exercise sendToUser / broadcast assign a minimal server mock.
  });

  describe('handleConnection', () => {
    it('accepts a client with a valid token and derives userId from the sub claim', async () => {
      jwtService.verifyAsync.mockResolvedValue({ sub: 'user-42', wallet: 'G...', role: 'farmer' });
      const client = mockSocket({
        handshake: { auth: { token: 'valid.jwt' }, headers: {}, query: {} } as never,
      });

      await gateway.handleConnection(client);

      expect(client.data.userId).toBe('user-42');
      expect(client.join).toHaveBeenCalledWith('user:user-42');
      expect(client.disconnect).not.toHaveBeenCalled();
    });

    it('ignores a client-supplied userId query param and trusts only the verified JWT', async () => {
      jwtService.verifyAsync.mockResolvedValue({
        sub: 'real-user',
        wallet: 'G...',
        role: 'farmer',
      });
      const client = mockSocket({
        handshake: {
          auth: { token: 'valid.jwt' },
          headers: {},
          query: { userId: 'someone-elses-id' },
        } as never,
      });

      await gateway.handleConnection(client);

      expect(client.data.userId).toBe('real-user');
      expect(client.join).toHaveBeenCalledWith('user:real-user');
      expect(client.join).not.toHaveBeenCalledWith('user:someone-elses-id');
    });

    it('disconnects a client that presents no token', async () => {
      const client = mockSocket();

      await gateway.handleConnection(client);

      expect(client.disconnect).toHaveBeenCalledWith(true);
      expect(client.join).not.toHaveBeenCalled();
    });

    it('disconnects a client whose token fails verification', async () => {
      jwtService.verifyAsync.mockRejectedValue(new Error('jwt expired'));
      const client = mockSocket({
        handshake: { auth: { token: 'bad.jwt' }, headers: {}, query: {} } as never,
      });

      await gateway.handleConnection(client);

      expect(client.disconnect).toHaveBeenCalledWith(true);
      expect(client.join).not.toHaveBeenCalled();
    });
  });

  describe('handleDisconnect', () => {
    it('logs disconnection for an authenticated user without throwing', async () => {
      jwtService.verifyAsync.mockResolvedValue({ sub: 'user-7', wallet: 'G...', role: 'farmer' });
      const client = mockSocket({
        handshake: { auth: { token: 'valid.jwt' }, headers: {}, query: {} } as never,
      });
      await gateway.handleConnection(client);

      expect(() => gateway.handleDisconnect(client)).not.toThrow();
    });

    it('handles disconnects for sockets that never authenticated', () => {
      const client = mockSocket();
      expect(() => gateway.handleDisconnect(client)).not.toThrow();
    });
  });
});
