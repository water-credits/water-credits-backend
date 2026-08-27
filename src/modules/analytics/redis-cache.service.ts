import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

@Injectable()
export class RedisCacheService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisCacheService.name);
  private client: Redis;
  private defaultTtlSeconds: number;

  constructor(private readonly configService: ConfigService) {
    const envTtl = this.configService.get<string>('ANALYTICS_CACHE_TTL_S');
    const parsed = parseInt(envTtl ?? '60', 10);
    this.defaultTtlSeconds = isNaN(parsed) ? 60 : parsed;
  }

  onModuleInit(): void {
    const host =
      this.configService.get<string>('queue.redisHost') ||
      this.configService.get<string>('REDIS_HOST') ||
      'localhost';
    const port =
      this.configService.get<number>('queue.redisPort') ||
      parseInt(this.configService.get<string>('REDIS_PORT', '6379'), 10) ||
      6379;
    const password =
      this.configService.get<string>('queue.redisPassword') ||
      this.configService.get<string>('REDIS_PASSWORD') ||
      undefined;
    const db =
      this.configService.get<number>('REDIS_ANALYTICS_DB') ||
      parseInt(this.configService.get<string>('REDIS_ANALYTICS_DB', '0'), 10) ||
      0;

    this.client = new Redis({
      host,
      port,
      password,
      db,
      lazyConnect: true,
      enableReadyCheck: false,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: 3000,
    });

    this.client.on('error', (err) => {
      this.logger.warn(`Redis analytics cache error: ${err.message}`);
    });
  }

  async onModuleDestroy(): Promise<void> {
    try {
      if (this.client) {
        await this.client.quit();
      }
    } catch (err) {
      this.logger.warn(`Error disconnecting Redis client: ${(err as Error).message}`);
    }
  }

  getClient(): Redis {
    return this.client;
  }

  async get<T>(key: string): Promise<T | null> {
    if (this.defaultTtlSeconds === 0) {
      return null;
    }
    try {
      if (!this.client) {
        return null;
      }
      const raw = await this.client.get(key);
      if (!raw) {
        return null;
      }
      return JSON.parse(raw) as T;
    } catch (err) {
      this.logger.warn(`Failed to get key "${key}" from Redis cache: ${(err as Error).message}`);
      return null;
    }
  }

  async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    const ttl = ttlSeconds !== undefined ? ttlSeconds : this.defaultTtlSeconds;
    if (ttl <= 0) {
      return;
    }
    try {
      if (!this.client) {
        return;
      }
      const serialized = JSON.stringify(value);
      await this.client.set(key, serialized, 'EX', ttl);
    } catch (err) {
      this.logger.warn(`Failed to set key "${key}" in Redis cache: ${(err as Error).message}`);
    }
  }

  async clear(pattern: string = 'analytics:*'): Promise<void> {
    try {
      if (!this.client) {
        return;
      }
      const keys = await this.client.keys(pattern);
      if (keys && keys.length > 0) {
        await this.client.del(...keys);
      }
    } catch (err) {
      this.logger.warn(
        `Failed to clear keys with pattern "${pattern}" from Redis cache: ${(err as Error).message}`,
      );
    }
  }
}
