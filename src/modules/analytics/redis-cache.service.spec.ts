import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { RedisCacheService } from './redis-cache.service';

const mockRedis = {
  get: jest.fn(),
  set: jest.fn(),
  keys: jest.fn(),
  del: jest.fn(),
  quit: jest.fn(),
  on: jest.fn(),
};

jest.mock('ioredis', () => {
  function RedisCtor() {
    return mockRedis;
  }
  RedisCtor.default = RedisCtor;
  return RedisCtor;
});

describe('RedisCacheService', () => {
  let service: RedisCacheService;
  let configService: jest.Mocked<ConfigService>;

  beforeEach(async () => {
    jest.clearAllMocks();

    const configMap: Record<string, unknown> = {
      'queue.redisHost': '127.0.0.1',
      'queue.redisPort': 6379,
      'queue.redisPassword': 'secretpassword',
      REDIS_ANALYTICS_DB: 2,
      ANALYTICS_CACHE_TTL_S: '120',
    };

    configService = {
      get: jest.fn((key: string, defaultVal?: unknown) => {
        return configMap[key] ?? defaultVal;
      }),
    } as unknown as jest.Mocked<ConfigService>;

    const module: TestingModule = await Test.createTestingModule({
      providers: [RedisCacheService, { provide: ConfigService, useValue: configService }],
    }).compile();

    service = module.get<RedisCacheService>(RedisCacheService);
    service.onModuleInit();
  });

  afterEach(async () => {
    await service.onModuleDestroy();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
    expect(service.getClient()).toBeDefined();
    expect(mockRedis.on).toHaveBeenCalledWith('error', expect.any(Function));
  });

  describe('get', () => {
    it('returns parsed object when key exists in Redis', async () => {
      const data = { count: 42, name: 'water' };
      mockRedis.get.mockResolvedValueOnce(JSON.stringify(data));

      const result = await service.get<typeof data>('analytics:test');

      expect(mockRedis.get).toHaveBeenCalledWith('analytics:test');
      expect(result).toEqual(data);
    });

    it('returns null on cache miss', async () => {
      mockRedis.get.mockResolvedValueOnce(null);

      const result = await service.get('analytics:missing');

      expect(result).toBeNull();
    });

    it('returns null and logs warning if Redis throws an error', async () => {
      mockRedis.get.mockRejectedValueOnce(new Error('Connection refused'));

      const result = await service.get('analytics:error');

      expect(result).toBeNull();
    });
  });

  describe('set', () => {
    it('serializes and stores data with default TTL', async () => {
      mockRedis.set.mockResolvedValueOnce('OK');
      const data = { total: 100 };

      await service.set('analytics:overview', data);

      expect(mockRedis.set).toHaveBeenCalledWith(
        'analytics:overview',
        JSON.stringify(data),
        'EX',
        120,
      );
    });

    it('stores data with custom TTL when provided', async () => {
      mockRedis.set.mockResolvedValueOnce('OK');
      const data = { total: 50 };

      await service.set('analytics:custom', data, 30);

      expect(mockRedis.set).toHaveBeenCalledWith(
        'analytics:custom',
        JSON.stringify(data),
        'EX',
        30,
      );
    });

    it('catches and logs error without throwing if Redis set fails', async () => {
      mockRedis.set.mockRejectedValueOnce(new Error('Write failed'));

      await expect(service.set('analytics:error', { ok: true })).resolves.toBeUndefined();
    });
  });

  describe('clear', () => {
    it('finds and deletes keys matching pattern', async () => {
      mockRedis.keys.mockResolvedValueOnce(['analytics:overview', 'analytics:top']);
      mockRedis.del.mockResolvedValueOnce(2);

      await service.clear('analytics:*');

      expect(mockRedis.keys).toHaveBeenCalledWith('analytics:*');
      expect(mockRedis.del).toHaveBeenCalledWith('analytics:overview', 'analytics:top');
    });

    it('does not call del when no keys match', async () => {
      mockRedis.keys.mockResolvedValueOnce([]);

      await service.clear('analytics:*');

      expect(mockRedis.keys).toHaveBeenCalledWith('analytics:*');
      expect(mockRedis.del).not.toHaveBeenCalled();
    });

    it('handles redis error during clear gracefully', async () => {
      mockRedis.keys.mockRejectedValueOnce(new Error('Redis offline'));

      await expect(service.clear('analytics:*')).resolves.toBeUndefined();
    });
  });

  describe('caching disabled (TTL=0)', () => {
    it('bypasses get and set when TTL is 0', async () => {
      const disabledConfigService = {
        get: jest.fn((key: string) => (key === 'ANALYTICS_CACHE_TTL_S' ? '0' : undefined)),
      } as unknown as jest.Mocked<ConfigService>;

      const disabledService = new RedisCacheService(disabledConfigService);
      disabledService.onModuleInit();

      const getRes = await disabledService.get('analytics:test');
      expect(getRes).toBeNull();
      expect(mockRedis.get).not.toHaveBeenCalled();

      await disabledService.set('analytics:test', { a: 1 });
      expect(mockRedis.set).not.toHaveBeenCalled();
    });
  });
});
