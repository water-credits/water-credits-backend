import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger, OnModuleDestroy } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { createAdapter } from '@socket.io/redis-adapter';
import { verifyWsToken } from '../../common/websockets/ws-jwt.util';

@WebSocketGateway({
  namespace: 'notifications',
  cors: {
    origin: process.env.NODE_ENV === 'production' ? process.env.CORS_ORIGIN : '*',
  },
})
export class NotificationsGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy
{
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(NotificationsGateway.name);

  /** Dedicated pub/sub clients — never shared with the Bull queue client. */
  private pubClient: Redis;
  private subClient: Redis;

  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  afterInit(server: Server): void {
    const host = this.configService.get<string>('REDIS_HOST', 'localhost');
    const port = this.configService.get<number>('REDIS_PORT', 6379);
    const password = this.configService.get<string>('REDIS_PASSWORD') || undefined;

    this.pubClient = new Redis({ host, port, password, lazyConnect: false });
    this.subClient = this.pubClient.duplicate();

    server.adapter(createAdapter(this.pubClient, this.subClient));
    this.logger.log('NotificationsGateway: Redis adapter initialised');
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.allSettled([this.pubClient?.quit(), this.subClient?.quit()]);
    this.logger.log('NotificationsGateway: Redis pub/sub connections closed');
  }

  async handleConnection(client: Socket) {
    const payload = await verifyWsToken(client, this.jwtService, this.logger);
    if (!payload) {
      client.disconnect(true);
      return;
    }

    // userId is derived solely from the verified JWT `sub` claim — never from
    // client-supplied query params, which previously allowed impersonation.
    const userId = payload.sub;
    client.data.userId = userId;

    client.join(`user:${userId}`);
    this.logger.log(`Client connected: ${client.id} (User: ${userId})`);
  }

  handleDisconnect(client: Socket) {
    const userId = client.data.userId as string | undefined;
    if (userId) {
      this.logger.log(`Client disconnected: ${client.id} (User: ${userId})`);
    } else {
      this.logger.log(`Client disconnected: ${client.id}`);
    }
  }

  sendToUser(userId: string, event: string, data: Record<string, unknown>) {
    this.server.to(`user:${userId}`).emit(event, data);
  }

  /**
   * Returns the number of sockets in the user's room.
   * Uses the adapter's room map so the count is accurate across all replicas
   * (each replica contributes its local sockets; the Redis adapter propagates
   * broadcasts, but rooms are tracked per-server — use this for local metrics only).
   */
  getLocalConnectionCount(userId: string): number {
    return this.server?.sockets?.adapter?.rooms?.get(`user:${userId}`)?.size ?? 0;
  }

  broadcast(event: string, data: Record<string, unknown>) {
    this.server.emit(event, data);
  }

  @SubscribeMessage('ping')
  handlePing(client: Socket, data: Record<string, unknown>) {
    return { event: 'pong', data };
  }
}
