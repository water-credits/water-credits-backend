import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private client: Redis;

  constructor(private readonly configService: ConfigService) {}

  onModuleInit(): void {
    this.client = new Redis({
      host: this.configService.get<string>('queue.redisHost', 'localhost'),
      port: this.configService.get<number>('queue.redisPort', 6379),
      password: this.configService.get<string>('queue.redisPassword') || undefined,
      // Isolated DB (default is 0) so challenge/rate-limit keys don't collide with queue data
      db: this.configService.get<number>('REDIS_AUTH_DB', 1),
      lazyConnect: true,
      enableReadyCheck: false,
    });
    this.client.on('error', (err) => this.logger.warn(`Redis auth client error: ${err.message}`));
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.quit();
  }

  getClient(): Redis {
    return this.client;
  }
}
