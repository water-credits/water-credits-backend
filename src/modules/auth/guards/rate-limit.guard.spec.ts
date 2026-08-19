import { Test, TestingModule } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import { HttpException, HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RateLimitGuard } from './rate-limit.guard';
import { RedisService } from '../redis.service';
import { AuthController } from '../auth.controller';

// ── Redis isolation strategy ──────────────────────────────────────────────────
//
// Mirrors auth.service.spec.ts: the entire 'ioredis' module is mocked so that
// RedisService's `new Redis(...)` returns a pre-wired mock client. The guard
// talks to Redis exclusively through this mock via `redisService.getClient()`.

const mockRedis = {
  eval: jest.fn(),
  quit: jest.fn().mockResolvedValue('OK'),
  on: jest.fn(),
};

jest.mock('ioredis', () => {
  function RedisCtor() {
    return mockRedis;
  }
  RedisCtor.default = RedisCtor;
  return RedisCtor;
});

function makeContext(handlerName: string, ip = '1.2.3.4') {
  const handler = { name: handlerName };
  return {
    getHandler: () => handler,
    getClass: () => AuthController,
    switchToHttp: () => ({ getRequest: () => ({ ip }) }),
  } as Parameters<RateLimitGuard['canActivate']>[0];
}

describe('RateLimitGuard', () => {
  let guard: RateLimitGuard;
  let reflector: Reflector;

  beforeEach(async () => {
    // Reset all mock Redis methods before each test.
    Object.values(mockRedis).forEach((fn) => {
      if (typeof fn === 'function' && 'mockReset' in fn) {
        (fn as jest.Mock).mockReset();
      }
    });
    // Re-apply safe defaults.
    mockRedis.quit.mockResolvedValue('OK');
    mockRedis.on.mockReturnValue(mockRedis);

    reflector = { getAllAndOverride: jest.fn() } as unknown as Reflector;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RedisService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, defaultValue?: unknown) => {
              const config: Record<string, unknown> = {
                REDIS_AUTH_DB: 1,
                'queue.redisHost': 'localhost',
                'queue.redisPort': 6379,
              };
              return config[key] ?? defaultValue;
            }),
          },
        },
        { provide: Reflector, useValue: reflector },
        RateLimitGuard,
      ],
    }).compile();

    // Initialise module to trigger RedisService.onModuleInit() → client creation.
    await module.init();
    guard = module.get(RateLimitGuard);
  });

  it('should be defined', () => {
    expect(guard).toBeDefined();
  });

  it('allows the request when no rate-limit metadata is present', async () => {
    (reflector.getAllAndOverride as jest.Mock).mockReturnValue(undefined);

    await expect(guard.canActivate(makeContext('logout'))).resolves.toBe(true);
    expect(mockRedis.eval).not.toHaveBeenCalled();
  });

  it('enforces the limit across simulated concurrent requests', async () => {
    (reflector.getAllAndOverride as jest.Mock).mockReturnValue({
      maxRequests: 10,
      windowMs: 60_000,
    });

    // Simulate the Redis INCR counter incrementing across concurrent calls.
    let counter = 0;
    mockRedis.eval.mockImplementation(() => Promise.resolve(++counter));

    const context = makeContext('login');
    const results = await Promise.allSettled(
      Array.from({ length: 11 }, () => guard.canActivate(context)),
    );

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(10);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
  });

  it('throws 429 Too Many Requests when the counter exceeds maxRequests', async () => {
    (reflector.getAllAndOverride as jest.Mock).mockReturnValue({
      maxRequests: 2,
      windowMs: 60_000,
    });

    mockRedis.eval.mockResolvedValue(3);

    await expect(guard.canActivate(makeContext('login'))).rejects.toThrow(HttpException);
    await expect(guard.canActivate(makeContext('login'))).rejects.toThrow('Too many requests');
    await expect(guard.canActivate(makeContext('login'))).rejects.toHaveProperty(
      'status',
      HttpStatus.TOO_MANY_REQUESTS,
    );
  });

  it('allows the request again after the window resets (counter back to 1)', async () => {
    (reflector.getAllAndOverride as jest.Mock).mockReturnValue({
      maxRequests: 2,
      windowMs: 60_000,
    });

    // First window: two requests allowed.
    mockRedis.eval.mockResolvedValueOnce(1).mockResolvedValueOnce(2);
    await expect(guard.canActivate(makeContext('refresh'))).resolves.toBe(true);
    await expect(guard.canActivate(makeContext('refresh'))).resolves.toBe(true);

    // Third request within the same window would be rejected...
    mockRedis.eval.mockResolvedValueOnce(3);
    await expect(guard.canActivate(makeContext('refresh'))).rejects.toThrow(HttpException);

    // ...but once the key expires the counter resets to 1 and the request is allowed.
    mockRedis.eval.mockResolvedValueOnce(1);
    await expect(guard.canActivate(makeContext('refresh'))).resolves.toBe(true);
  });

  it('fails open when Redis is unavailable (eval throws)', async () => {
    (reflector.getAllAndOverride as jest.Mock).mockReturnValue({
      maxRequests: 2,
      windowMs: 60_000,
    });

    mockRedis.eval.mockRejectedValue(new Error('Redis connection refused'));

    await expect(guard.canActivate(makeContext('login'))).resolves.toBe(true);
  });

  it('uses the ip:endpoint key format scoped to the handler', async () => {
    (reflector.getAllAndOverride as jest.Mock).mockReturnValue({
      maxRequests: 10,
      windowMs: 60_000,
    });

    mockRedis.eval.mockResolvedValue(1);

    await guard.canActivate(makeContext('challenge', '9.9.9.9'));

    expect(mockRedis.eval).toHaveBeenCalledWith(
      expect.stringContaining('INCR'),
      1,
      'rl:9.9.9.9:challenge',
      60_000,
    );
  });

  it('defaults to anonymous when the request has no ip', async () => {
    (reflector.getAllAndOverride as jest.Mock).mockReturnValue({
      maxRequests: 10,
      windowMs: 60_000,
    });

    mockRedis.eval.mockResolvedValue(1);

    const context = {
      getHandler: () => ({ name: 'challenge' }),
      getClass: () => AuthController,
      switchToHttp: () => ({ getRequest: () => ({}) }),
    } as Parameters<RateLimitGuard['canActivate']>[0];

    await guard.canActivate(context);

    expect(mockRedis.eval).toHaveBeenCalledWith(
      expect.stringContaining('INCR'),
      1,
      'rl:anonymous:challenge',
      60_000,
    );
  });
});
