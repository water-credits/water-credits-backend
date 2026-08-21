import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  ConnectedSocket,
  MessageBody,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Inject, Logger, OnModuleDestroy } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { ThrottlerStorage } from '@nestjs/throttler';
import Redis from 'ioredis';
import { createAdapter } from '@socket.io/redis-adapter';
import { verifyWsToken } from '../../common/websockets/ws-jwt.util';
import { SensorProjectAccessService } from './sensor-project-access.service';
import { corsOptions } from '../../config/cors.config';
import {
  WS_CONNECTION_THROTTLE,
  WS_SUBSCRIBE_THROTTLE,
} from '../../common/decorators/throttle.decorator';

const PROJECT_PREFIX = 'project:';

@WebSocketGateway({
  namespace: '/sensors',
  cors: corsOptions,
})
export class SensorsGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy
{
  private readonly logger = new Logger(SensorsGateway.name);

  @WebSocketServer()
  server: Server;

  /** Dedicated pub/sub clients — never shared with the Bull queue client. */
  private pubClient: Redis;
  private subClient: Redis;

  constructor(
    private readonly jwtService: JwtService,
    private readonly projectAccess: SensorProjectAccessService,
    private readonly configService: ConfigService,
    @Inject(ThrottlerStorage) private readonly throttlerStorage: ThrottlerStorage,
  ) {}

  afterInit(server: Server): void {
    const host = this.configService.get<string>('REDIS_HOST', 'localhost');
    const port = this.configService.get<number>('REDIS_PORT', 6379);
    const password = this.configService.get<string>('REDIS_PASSWORD') || undefined;

    this.pubClient = new Redis({ host, port, password, lazyConnect: false });
    this.subClient = this.pubClient.duplicate();

    server.adapter(createAdapter(this.pubClient, this.subClient));
    this.logger.log('SensorsGateway: Redis adapter initialised');
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.allSettled([this.pubClient?.quit(), this.subClient?.quit()]);
    this.logger.log('SensorsGateway: Redis pub/sub connections closed');
  }

  async handleConnection(client: Socket): Promise<void> {
    const ip = client.handshake.address ?? 'unknown';
    if (await this.isThrottled(`ws:sensors:connect:${ip}`, WS_CONNECTION_THROTTLE)) {
      this.logger.warn(
        `Rejected connection ${client.id}: connection rate limit exceeded for ${ip}`,
      );
      client.emit('error', { message: 'Too many connection attempts, please slow down' });
      client.disconnect(true);
      return;
    }

    const payload = await verifyWsToken(client, this.jwtService, this.logger);
    if (!payload) {
      client.disconnect(true);
      return;
    }

    client.data.userId = payload.sub;
    client.data.role = payload.role;
    this.logger.log(`Client connected: ${client.id} (User: ${payload.sub})`);
  }

  handleDisconnect(client: Socket): void {
    this.logger.log(`Client disconnected: ${client.id}`);
    const rooms = Array.from(client.rooms).filter((r) => r !== client.id);
    for (const room of rooms) {
      client.leave(room);
    }
  }

  @SubscribeMessage('subscribe:project')
  async handleSubscribeProject(
    @ConnectedSocket() client: Socket,
    @MessageBody() projectId: string,
  ): Promise<void> {
    if (await this.isSubscribeThrottled(client)) {
      return;
    }

    const allowed = await this.canAccessProject(client, projectId);
    if (!allowed) {
      client.emit('error', { message: 'Forbidden: no access to this project' });
      this.logger.warn(
        `Client ${client.id} (user ${client.data.userId}) denied subscription to project ${projectId}`,
      );
      return;
    }

    const room = `${PROJECT_PREFIX}${projectId}`;
    client.join(room);
    this.logger.log(`Client ${client.id} subscribed to project ${projectId}`);
  }

  @SubscribeMessage('unsubscribe:project')
  async handleUnsubscribeProject(
    @ConnectedSocket() client: Socket,
    @MessageBody() projectId: string,
  ): Promise<void> {
    if (await this.isSubscribeThrottled(client)) {
      return;
    }

    const room = `${PROJECT_PREFIX}${projectId}`;
    client.leave(room);
    this.logger.log(`Client ${client.id} unsubscribed from project ${projectId}`);
  }

  emitReading(projectId: string, reading: Record<string, unknown>): void {
    this.server.to(`${PROJECT_PREFIX}${projectId}`).emit('sensor:reading', reading);
  }

  emitAlert(projectId: string, alert: Record<string, unknown>): void {
    this.server.to(`${PROJECT_PREFIX}${projectId}`).emit('sensor:alert', alert);
  }

  // Project owners always have access; admins/verifiers/oracles may observe
  // any project. Everyone else is denied.
  private async canAccessProject(client: Socket, projectId: string): Promise<boolean> {
    return this.projectAccess.canAccessProject(
      client.data.userId as string | undefined,
      client.data.role as string | undefined,
      projectId,
    );
  }

  // subscribe:project and unsubscribe:project share one counter per client so
  // rapid subscribe/unsubscribe cycling can't be used to dodge the limit.
  private async isSubscribeThrottled(client: Socket): Promise<boolean> {
    const key = `ws:sensors:subscribe:${(client.data.userId as string | undefined) ?? client.id}`;
    const throttled = await this.isThrottled(key, WS_SUBSCRIBE_THROTTLE);
    if (throttled) {
      client.emit('error', { message: 'Too many subscription requests, please slow down' });
      this.logger.warn(`Client ${client.id} throttled: subscribe/unsubscribe rate limit exceeded`);
    }
    return throttled;
  }

  private async isThrottled(
    key: string,
    { limit, ttl }: { limit: number; ttl: number },
  ): Promise<boolean> {
    const { totalHits } = await this.throttlerStorage.increment(key, ttl);
    return totalHits > limit;
  }
}
