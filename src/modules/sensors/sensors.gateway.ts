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
import { Logger, OnModuleDestroy } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { createAdapter } from '@socket.io/redis-adapter';
import { verifyWsToken } from '../../common/websockets/ws-jwt.util';
import { ProjectsService } from '../projects/projects.service';
import { UserRole } from '../users/entities/user.entity';

const PROJECT_PREFIX = 'project:';

// Roles that may observe any project's sensor stream regardless of ownership.
const PRIVILEGED_ROLES = new Set<string>([UserRole.ADMIN, UserRole.VERIFIER, UserRole.ORACLE]);

@WebSocketGateway({
  namespace: '/sensors',
  cors: {
    origin: process.env.NODE_ENV === 'production' ? process.env.CORS_ORIGIN : '*',
    credentials: true,
  },
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
    private readonly projectsService: ProjectsService,
    private readonly configService: ConfigService,
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
  handleUnsubscribeProject(
    @ConnectedSocket() client: Socket,
    @MessageBody() projectId: string,
  ): void {
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
    const userId = client.data.userId as string | undefined;
    const role = client.data.role as string | undefined;
    if (!userId) {
      return false;
    }
    if (role && PRIVILEGED_ROLES.has(role)) {
      return true;
    }

    try {
      const project = await this.projectsService.findById(projectId);
      return project.ownerId === userId;
    } catch {
      return false;
    }
  }
}
