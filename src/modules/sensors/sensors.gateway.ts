import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  ConnectedSocket,
  MessageBody,
} from '@nestjs/websockets';
import { Namespace, Socket } from 'socket.io';
import { Inject, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
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
import {
  DEFAULT_WS_REDIS_CONNECT_TIMEOUT_MS,
  MAX_WS_REDIS_CONNECT_TIMEOUT_MS,
} from '../../config/sensor.config';

const PROJECT_PREFIX = 'project:';
const REDIS_RETRY_BASE_DELAY_MS = 50;
const REDIS_RETRY_MAX_DELAY_MS = 5_000;
const REDIS_RETRY_JITTER_MS = 200;

type RedisClientRole = 'publisher' | 'subscriber';

@WebSocketGateway({
  namespace: '/sensors',
  cors: corsOptions,
})
export class SensorsGateway
  implements OnModuleInit, OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy
{
  private readonly logger = new Logger(SensorsGateway.name);

  @WebSocketServer()
  server: Namespace;

  /** Dedicated pub/sub clients — never shared with the Bull queue client. */
  private pubClient?: Redis;
  private subClient?: Redis;

  constructor(
    private readonly jwtService: JwtService,
    private readonly projectAccess: SensorProjectAccessService,
    private readonly configService: ConfigService,
    @Inject(ThrottlerStorage) private readonly throttlerStorage: ThrottlerStorage,
  ) {}

  async onModuleInit(): Promise<void> {
    const host = this.configService.get<string>('REDIS_HOST')?.trim();
    if (!host) {
      this.logger.log('SensorsGateway: using in-process adapter (Redis not configured)');
      return;
    }

    const port = this.resolveRedisPort(this.configService.get<string | number>('REDIS_PORT', 6379));
    const password = this.configService.get<string>('REDIS_PASSWORD') || undefined;
    const timeoutMs = this.resolveConnectTimeout(
      this.configService.get<string | number>(
        'sensor.wsRedisConnectTimeoutMs',
        DEFAULT_WS_REDIS_CONNECT_TIMEOUT_MS,
      ),
    );

    let pubClient: Redis | undefined;
    let subClient: Redis | undefined;

    try {
      const publisher = new Redis({
        host,
        port,
        password,
        lazyConnect: true,
        connectTimeout: timeoutMs,
        retryStrategy: (attempt) => this.redisRetryDelay(attempt),
      });
      pubClient = publisher;
      const subscriber = publisher.duplicate();
      subClient = subscriber;

      this.attachErrorListener(publisher, 'publisher');
      this.attachErrorListener(subscriber, 'subscriber');

      await this.withTimeout(
        Promise.all([publisher.connect(), subscriber.connect()]).then(async () => {
          await Promise.all([publisher.ping(), subscriber.ping()]);
        }),
        timeoutMs,
      );

      // A namespaced NestJS gateway receives a Socket.IO Namespace, not a
      // Server. Replace only this namespace's adapter after both Redis clients
      // have proven ready; otherwise its existing in-process adapter remains.
      this.server.adapter = createAdapter(publisher, subscriber)(this.server);
      this.pubClient = publisher;
      this.subClient = subscriber;

      this.logger.log('SensorsGateway: Redis adapter initialised');
    } catch {
      this.disconnectRedisClient(pubClient, 'publisher');
      this.disconnectRedisClient(subClient, 'subscriber');
      this.logger.warn('SensorsGateway falling back to in-process adapter');
    }
  }

  async onModuleDestroy(): Promise<void> {
    const clients = [this.pubClient, this.subClient].filter(
      (client): client is Redis => client !== undefined,
    );
    this.pubClient = undefined;
    this.subClient = undefined;

    await Promise.allSettled(clients.map(async (client) => client.quit()));
    if (clients.length > 0) {
      this.logger.log('SensorsGateway: Redis pub/sub connections closed');
    }
  }

  private attachErrorListener(client: Redis, role: RedisClientRole): void {
    client.on('error', (error: Error) => this.logRedisWarning(role, error));
  }

  private logRedisWarning(role: RedisClientRole, error: Error): void {
    const code = (error as NodeJS.ErrnoException).code;
    this.logger.warn({
      message: 'SensorsGateway Redis client error',
      client: role,
      error: {
        name: error.name,
        message: error.message,
        ...(code ? { code } : {}),
      },
    });
  }

  private disconnectRedisClient(client: Redis | undefined, role: RedisClientRole): void {
    if (!client) {
      return;
    }

    try {
      client.disconnect();
    } catch (error) {
      this.logRedisWarning(role, error as Error);
    }
  }

  private redisRetryDelay(attempt: number): number {
    const exponentialDelay = Math.min(
      REDIS_RETRY_BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1),
      REDIS_RETRY_MAX_DELAY_MS,
    );
    return exponentialDelay + Math.floor(Math.random() * REDIS_RETRY_JITTER_MS);
  }

  private resolveRedisPort(value: string | number): number {
    const port = Number(value);
    return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : 6379;
  }

  private resolveConnectTimeout(value: string | number): number {
    const timeoutMs = Number(value);
    return Number.isSafeInteger(timeoutMs) &&
      timeoutMs > 0 &&
      timeoutMs <= MAX_WS_REDIS_CONNECT_TIMEOUT_MS
      ? timeoutMs
      : DEFAULT_WS_REDIS_CONNECT_TIMEOUT_MS;
  }

  private async withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
    let timeoutHandle: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(
        () => reject(new Error(`Redis connection timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
    });

    try {
      return await Promise.race([operation, timeout]);
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
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
