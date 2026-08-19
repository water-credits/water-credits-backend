import { Test, TestingModule } from '@nestjs/testing';
import { UnauthorizedException, ConflictException, BadRequestException } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Keypair } from '@stellar/stellar-sdk';
import * as crypto from 'crypto';
import { AuthService } from './auth.service';
import { RedisService } from './redis.service';
import { User, UserRole } from '../users/entities/user.entity';

// ── Redis isolation strategy ──────────────────────────────────────────────────
//
// RedisService (shared with RateLimitGuard) creates its own ioredis client
// inside onModuleInit() via:
//
//   this.client = new Redis({ ... })
//
// To prevent tests from requiring a live Redis instance we module-mock the
// entire 'ioredis' module before the service module is loaded.  This replaces
// every `new Redis(...)` call with a constructor that returns a pre-wired mock
// whose methods (get, set, del, getdel, quit) are controlled per-test via the
// exported `mockRedis` object.
//
// The mock is reset in beforeEach so tests are isolated from each other.

// The shared mock object tests can configure per-scenario.
const mockRedis = {
  get: jest.fn(),
  set: jest.fn().mockResolvedValue('OK'),
  del: jest.fn().mockResolvedValue(1),
  getdel: jest.fn(),
  quit: jest.fn().mockResolvedValue('OK'),
  on: jest.fn(),
};

// Replace the ioredis module so AuthService's `new Redis(...)` returns our mock.
//
// AuthService uses `import Redis from 'ioredis'` which ts-jest compiles under
// CommonJS as:
//   const ioredis_1 = require('ioredis');
//   new (ioredis_1.default || ioredis_1)({ ... })
//
// We therefore expose the mock constructor on BOTH the module root and the
// `.default` property to satisfy both access patterns.
jest.mock('ioredis', () => {
  function RedisCtor() {
    return mockRedis;
  }
  RedisCtor.default = RedisCtor;
  return RedisCtor;
});

// Reusable query builder mock (reset per-test via beforeEach).
function mockQueryBuilder() {
  return {
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    getOne: jest.fn(),
  };
}

// SHA-256 HMAC helper matching the service's hashRefreshToken.
function hashToken(token: string): string {
  const secret = 'test-secret-at-least-32-chars-long';
  return crypto.createHmac('sha256', secret).update(token).digest('hex');
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 'user-uuid-1',
    wallet: 'GABC123',
    email: null,
    displayName: null,
    role: UserRole.FARMER,
    isKycVerified: false,
    isActive: true,
    refreshToken: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as User;
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('AuthService', () => {
  let module!: TestingModule;
  let service: AuthService;
  let userRepo: {
    findOne: jest.Mock;
    createQueryBuilder: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    update: jest.Mock;
  };
  let jwtService: { signAsync: jest.Mock; verify: jest.Mock };

  // A real Stellar keypair used for signature tests — generated once per suite.
  let testKeypair: Keypair;

  beforeAll(() => {
    testKeypair = Keypair.random();
  });

  beforeEach(async () => {
    // Reset all mock Redis methods before each test.
    Object.values(mockRedis).forEach((fn) => {
      if (typeof fn === 'function' && 'mockReset' in fn) {
        (fn as jest.Mock).mockReset();
      }
    });
    // Re-apply safe defaults.
    mockRedis.set.mockResolvedValue('OK');
    mockRedis.del.mockResolvedValue(1);
    mockRedis.quit.mockResolvedValue('OK');
    mockRedis.on.mockReturnValue(mockRedis);

    userRepo = {
      findOne: jest.fn().mockResolvedValue(null),
      createQueryBuilder: jest.fn().mockReturnValue(mockQueryBuilder()),
      create: jest.fn(),
      save: jest.fn(),
      update: jest.fn().mockResolvedValue(undefined),
    };

    jwtService = {
      signAsync: jest.fn().mockResolvedValue('signed-jwt-token'),
      verify: jest.fn(),
    };

    module = await Test.createTestingModule({
      providers: [
        AuthService,
        RedisService,
        { provide: getRepositoryToken(User), useValue: userRepo },
        { provide: JwtService, useValue: jwtService },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              const config: Record<string, string | number> = {
                'jwt.secret': 'test-secret-at-least-32-chars-long',
                'jwt.expiration': '1h',
                'queue.redisHost': 'localhost',
                'queue.redisPort': 6379,
                REDIS_AUTH_DB: 1,
              };
              return config[key];
            }),
          },
        },
      ],
    }).compile();

    // Initialise module to trigger onModuleInit() → Redis client creation.
    await module.init();
    service = module.get<AuthService>(AuthService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  // ── generateChallenge ────────────────────────────────────────────────────

  describe('generateChallenge', () => {
    it('returns a non-empty challenge string and an expiresAt date in the future', () => {
      mockRedis.set.mockResolvedValue('OK');

      const before = Date.now();
      const { challenge, expiresAt } = service.generateChallenge('GTEST123');

      expect(typeof challenge).toBe('string');
      expect(challenge.length).toBeGreaterThan(0);
      expect(expiresAt.getTime()).toBeGreaterThan(before);
    });

    it('returns a different challenge on each call', () => {
      mockRedis.set.mockResolvedValue('OK');

      const { challenge: c1 } = service.generateChallenge('GTEST123');
      const { challenge: c2 } = service.generateChallenge('GTEST123');

      expect(c1).not.toBe(c2);
    });

    it('stores the challenge in Redis with a TTL (fire-and-forget; no await required)', () => {
      mockRedis.set.mockResolvedValue('OK');
      service.generateChallenge('GTEST123');
      // Allow the unhandled promise to settle before asserting.
      return new Promise<void>((resolve) => {
        setImmediate(() => {
          expect(mockRedis.set).toHaveBeenCalledWith(
            expect.stringContaining('auth:challenge:gtest123'),
            expect.any(String),
            'EX',
            300, // 5 minutes = 300 seconds
          );
          resolve();
        });
      });
    });

    it('swallows Redis set errors silently (fire-and-forget error path)', () => {
      // When redis.set rejects, the .catch() handler logs the error and does not
      // propagate — generateChallenge must still return normally.
      mockRedis.set.mockRejectedValue(new Error('Redis write failure'));

      let result: ReturnType<typeof service.generateChallenge> | undefined;
      expect(() => {
        result = service.generateChallenge('GTEST456');
      }).not.toThrow();

      expect(result).toBeDefined();
      expect(typeof result!.challenge).toBe('string');

      // Let the rejected promise settle so the .catch() handler fires and the
      // unhandled rejection doesn't bleed into later tests.
      return new Promise<void>((resolve) => setImmediate(resolve));
    });
  });

  // ── validateStellarSignature ─────────────────────────────────────────────

  describe('validateStellarSignature', () => {
    const CHALLENGE = 'test-challenge-hex-string-32bytes';

    function buildSignature(keypair: Keypair, challenge: string): string {
      // AuthService verifies with: keypair.verify(Buffer.from(challenge), Buffer.from(sig, 'hex'))
      const sigBytes = keypair.sign(Buffer.from(challenge));
      return Buffer.from(sigBytes).toString('hex');
    }

    it('returns the matching User when the signature is valid and the challenge matches', async () => {
      const realWallet = testKeypair.publicKey();
      const signature = buildSignature(testKeypair, CHALLENGE);
      const user = makeUser({ wallet: realWallet });

      mockRedis.getdel.mockResolvedValue(CHALLENGE);
      userRepo.findOne.mockResolvedValue(user);

      const result = await service.validateStellarSignature(realWallet, signature, CHALLENGE);

      expect(result).toEqual(user);
    });

    it('returns null when the stored challenge does not match the provided challenge', async () => {
      const realWallet = testKeypair.publicKey();
      const signature = buildSignature(testKeypair, CHALLENGE);

      // Redis has a different challenge stored (or it was already consumed).
      mockRedis.getdel.mockResolvedValue('completely-different-challenge');

      const result = await service.validateStellarSignature(realWallet, signature, CHALLENGE);

      expect(result).toBeNull();
    });

    it('returns null when no challenge exists in Redis (null returned by getdel)', async () => {
      const realWallet = testKeypair.publicKey();
      const signature = buildSignature(testKeypair, CHALLENGE);

      mockRedis.getdel.mockResolvedValue(null);

      const result = await service.validateStellarSignature(realWallet, signature, CHALLENGE);

      expect(result).toBeNull();
    });

    it('returns null when the signature is signed by a different keypair (wrong wallet)', async () => {
      const realWallet = testKeypair.publicKey();
      const wrongKeypair = Keypair.random();
      const wrongSignature = buildSignature(wrongKeypair, CHALLENGE); // signed with wrong key

      mockRedis.getdel.mockResolvedValue(CHALLENGE);

      const result = await service.validateStellarSignature(realWallet, wrongSignature, CHALLENGE);

      expect(result).toBeNull();
    });

    it('returns null for a malformed signature string', async () => {
      const realWallet = testKeypair.publicKey();

      mockRedis.getdel.mockResolvedValue(CHALLENGE);

      // 'not-hex-at-all' is not valid hex and will cause Buffer.from to produce
      // unexpected bytes, resulting in a failed verification.
      const result = await service.validateStellarSignature(
        realWallet,
        'not-hex-at-all',
        CHALLENGE,
      );

      expect(result).toBeNull();
    });

    it('returns null for a malformed wallet/public key', async () => {
      mockRedis.getdel.mockResolvedValue(CHALLENGE);

      // Keypair.fromPublicKey will throw for an invalid key; verifySignature
      // catches and returns null.
      const result = await service.validateStellarSignature(
        'not-a-valid-stellar-key',
        'aabbcc',
        CHALLENGE,
      );

      expect(result).toBeNull();
    });

    // ── Challenge replay protection ──────────────────────────────────────

    it('challenge replay: the second call with the same challenge must fail', async () => {
      const realWallet = testKeypair.publicKey();
      const signature = buildSignature(testKeypair, CHALLENGE);
      const user = makeUser({ wallet: realWallet });

      // First call — challenge is present, returns it and deletes it atomically.
      mockRedis.getdel.mockResolvedValueOnce(CHALLENGE);
      userRepo.findOne.mockResolvedValue(user);

      const first = await service.validateStellarSignature(realWallet, signature, CHALLENGE);
      expect(first).toEqual(user);

      // Second call — challenge was already consumed (getdel returns null).
      mockRedis.getdel.mockResolvedValueOnce(null);

      const second = await service.validateStellarSignature(realWallet, signature, CHALLENGE);
      expect(second).toBeNull();
    });

    // ── Expired challenge ────────────────────────────────────────────────

    it('expired challenge: getdel returns null when TTL has elapsed', async () => {
      // In Redis, a key that has expired is automatically removed; getdel on a
      // missing key returns null.  We simulate this here.
      const realWallet = testKeypair.publicKey();
      const signature = buildSignature(testKeypair, CHALLENGE);

      mockRedis.getdel.mockResolvedValue(null); // TTL expired

      const result = await service.validateStellarSignature(realWallet, signature, CHALLENGE);

      expect(result).toBeNull();
    });

    // ── GETDEL fallback path ─────────────────────────────────────────────

    it('falls back to GET + DEL when getdel throws (older Redis versions)', async () => {
      const realWallet = testKeypair.publicKey();
      const signature = buildSignature(testKeypair, CHALLENGE);
      const user = makeUser({ wallet: realWallet });

      mockRedis.getdel.mockRejectedValue(new Error('ERR unknown command'));
      mockRedis.get.mockResolvedValue(CHALLENGE);
      mockRedis.del.mockResolvedValue(1);
      userRepo.findOne.mockResolvedValue(user);

      const result = await service.validateStellarSignature(realWallet, signature, CHALLENGE);

      expect(result).toEqual(user);
      expect(mockRedis.get).toHaveBeenCalled();
      expect(mockRedis.del).toHaveBeenCalled();
    });
  });

  // ── login ────────────────────────────────────────────────────────────────

  describe('login', () => {
    const CHALLENGE = 'login-challenge-string-32bytes-xx';

    function buildSignature(keypair: Keypair, challenge: string): string {
      return Buffer.from(keypair.sign(Buffer.from(challenge))).toString('hex');
    }

    it('returns tokens and user on successful login', async () => {
      const realWallet = testKeypair.publicKey();
      const signature = buildSignature(testKeypair, CHALLENGE);
      const user = makeUser({ wallet: realWallet });

      mockRedis.getdel.mockResolvedValue(CHALLENGE);
      userRepo.findOne.mockResolvedValue(user);
      userRepo.save.mockResolvedValue(user);

      const result = await service.login(realWallet, signature, CHALLENGE);

      expect(result.accessToken).toBe('signed-jwt-token');
      expect(result.user).toBeDefined();
    });

    it('throws UnauthorizedException when validateStellarSignature returns null', async () => {
      // Challenge mismatch → validateStellarSignature returns null.
      mockRedis.getdel.mockResolvedValue(null);

      await expect(service.login('GSOME_WALLET', 'bad-sig', CHALLENGE)).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });

  // ── register ─────────────────────────────────────────────────────────────

  describe('register', () => {
    const CHALLENGE = 'register-challenge-32bytes-xxxxxx';

    function buildSignature(keypair: Keypair, challenge: string): string {
      return Buffer.from(keypair.sign(Buffer.from(challenge))).toString('hex');
    }

    it('creates a new user and returns tokens on first registration', async () => {
      const realWallet = testKeypair.publicKey();
      const signature = buildSignature(testKeypair, CHALLENGE);
      const newUser = makeUser({ wallet: realWallet });

      mockRedis.getdel.mockResolvedValue(CHALLENGE);
      userRepo.findOne.mockResolvedValue(null); // wallet not yet registered
      userRepo.create.mockReturnValue(newUser);
      userRepo.save.mockResolvedValue(newUser);

      const result = await service.register(realWallet, signature, CHALLENGE);

      expect(result.accessToken).toBe('signed-jwt-token');
      expect(userRepo.create).toHaveBeenCalled();
    });

    it('throws ConflictException when the wallet is already registered', async () => {
      const realWallet = testKeypair.publicKey();
      const signature = buildSignature(testKeypair, CHALLENGE);
      const existingUser = makeUser({ wallet: realWallet });

      mockRedis.getdel.mockResolvedValue(CHALLENGE);
      userRepo.findOne.mockResolvedValue(existingUser);

      await expect(service.register(realWallet, signature, CHALLENGE)).rejects.toThrow(
        ConflictException,
      );
    });

    it('throws BadRequestException when the challenge is invalid or expired', async () => {
      mockRedis.getdel.mockResolvedValue(null);

      await expect(service.register('GTEST', 'bad-sig', CHALLENGE)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  // ── login — deactivated user ─────────────────────────────────────────────

  describe('login — deactivated account', () => {
    const CHALLENGE = 'deactivated-challenge-32bytes-xx';

    function buildSignature(keypair: Keypair, challenge: string): string {
      return Buffer.from(keypair.sign(Buffer.from(challenge))).toString('hex');
    }

    it('throws UnauthorizedException when the matched user has isActive=false', async () => {
      const realWallet = testKeypair.publicKey();
      const signature = buildSignature(testKeypair, CHALLENGE);
      // validateStellarSignature only returns users where isActive=true; to
      // exercise the login-level isActive check we stub validateStellarSignature
      // directly by making userRepo.findOne return null (so validateStellarSignature
      // returns null) which triggers the first guard.  To hit the second guard
      // (isActive=false check inside login) we need to bypass validateStellarSignature
      // returning null and instead make it return an inactive user.
      // We achieve this by mocking getdel to return the challenge (valid) and
      // having userRepo.findOne return an inactive user.
      const inactiveUser = makeUser({ wallet: realWallet, isActive: false });
      mockRedis.getdel.mockResolvedValue(CHALLENGE);
      userRepo.findOne.mockResolvedValue(inactiveUser);

      await expect(service.login(realWallet, signature, CHALLENGE)).rejects.toThrow(
        UnauthorizedException,
      );
      await expect(service.login(realWallet, signature, CHALLENGE)).rejects.toThrow(
        'Account is deactivated',
      );
    });
  });

  // ── register — invalid signature path ───────────────────────────────────

  describe('register — invalid signature in try block', () => {
    const CHALLENGE = 'register-invalid-sig-challenge-xx';

    it('throws UnauthorizedException when the signature verification returns false', async () => {
      const realWallet = testKeypair.publicKey();
      // Sign with a different keypair so verify() returns false (not throw).
      const wrongKeypair = Keypair.random();
      const badSignature = Buffer.from(wrongKeypair.sign(Buffer.from(CHALLENGE))).toString('hex');

      mockRedis.getdel.mockResolvedValue(CHALLENGE);
      userRepo.findOne.mockResolvedValue(null);

      await expect(service.register(realWallet, badSignature, CHALLENGE)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('throws UnauthorizedException when the wallet key is malformed (Keypair.fromPublicKey throws)', async () => {
      mockRedis.getdel.mockResolvedValue(CHALLENGE);
      userRepo.findOne.mockResolvedValue(null);

      await expect(service.register('not-a-valid-key', 'aabbcc', CHALLENGE)).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });

  // ── register — GET+DEL fallback in register ──────────────────────────────

  describe('register — GET+DEL fallback when getdel throws', () => {
    const CHALLENGE = 'register-fallback-challenge-xxxxx';

    it('falls back to GET+DEL and proceeds with registration when getdel throws', async () => {
      const realWallet = testKeypair.publicKey();
      const signature = Buffer.from(testKeypair.sign(Buffer.from(CHALLENGE))).toString('hex');
      const newUser = makeUser({ wallet: realWallet });

      mockRedis.getdel.mockRejectedValue(new Error('ERR unknown command'));
      mockRedis.get.mockResolvedValue(CHALLENGE);
      mockRedis.del.mockResolvedValue(1);
      userRepo.findOne.mockResolvedValue(null);
      userRepo.create.mockReturnValue(newUser);
      userRepo.save.mockResolvedValue(newUser);

      const result = await service.register(realWallet, signature, CHALLENGE);

      expect(result.accessToken).toBe('signed-jwt-token');
      expect(mockRedis.get).toHaveBeenCalled();
      expect(mockRedis.del).toHaveBeenCalled();
    });
  });

  // ── refresh ──────────────────────────────────────────────────────────────

  describe('refresh', () => {
    let qb: ReturnType<typeof mockQueryBuilder>;

    beforeEach(() => {
      qb = mockQueryBuilder();
      userRepo.createQueryBuilder.mockReturnValue(qb);
    });

    it('returns new tokens when the refresh token is valid and the hash matches', async () => {
      const token = 'valid-refresh-token';
      const user = makeUser({ refreshToken: hashToken(token) });

      jwtService.verify.mockReturnValue({ sub: user.id });
      qb.getOne.mockResolvedValue(user);

      const result = await service.refresh(token);

      expect(result.accessToken).toBe('signed-jwt-token');
      expect(result.refreshToken).toBe('signed-jwt-token');
      // Verify the new refresh token is also hashed when stored
      expect(userRepo.update).toHaveBeenCalledWith(
        user.id,
        expect.objectContaining({ refreshToken: expect.any(String) }),
      );
      const storedHash = (userRepo.update.mock.calls[0] as [string, { refreshToken: string }])[1]
        .refreshToken;
      expect(storedHash).not.toBe(token);
      expect(storedHash).toMatch(/^[0-9a-f]{64}$/); // SHA-256 hex digest
    });

    it('throws UnauthorizedException when jwtService.verify throws (expired or invalid token)', async () => {
      jwtService.verify.mockImplementation(() => {
        throw new Error('jwt expired');
      });

      await expect(service.refresh('expired-token')).rejects.toThrow(UnauthorizedException);
    });

    it('throws UnauthorizedException when user is not found for the token sub', async () => {
      jwtService.verify.mockReturnValue({ sub: 'nonexistent-user-id' });
      qb.getOne.mockResolvedValue(null);

      await expect(service.refresh('some-token')).rejects.toThrow(UnauthorizedException);
    });

    it('throws UnauthorizedException when the stored refreshToken does not match (tampered token)', async () => {
      const user = makeUser({ refreshToken: hashToken('real-token') });
      jwtService.verify.mockReturnValue({ sub: user.id });
      qb.getOne.mockResolvedValue(user);

      await expect(service.refresh('different-token')).rejects.toThrow(UnauthorizedException);
    });

    it('throws UnauthorizedException when the stored refreshToken is null (after migration or logout)', async () => {
      const user = makeUser({ refreshToken: null });
      jwtService.verify.mockReturnValue({ sub: user.id });
      qb.getOne.mockResolvedValue(user);

      await expect(service.refresh('some-token')).rejects.toThrow(UnauthorizedException);
    });
  });

  // ── onModuleDestroy ──────────────────────────────────────────────────────

  describe('onModuleDestroy', () => {
    it('calls redis.quit() when the module is destroyed', async () => {
      mockRedis.quit.mockResolvedValue('OK');

      // Redis connection lifecycle now lives on the shared RedisService.
      const redisService = module.get<RedisService>(RedisService);
      await (redisService as unknown as { onModuleDestroy: () => Promise<void> }).onModuleDestroy();

      expect(mockRedis.quit).toHaveBeenCalled();
    });
  });

  // ── Redis error handler ──────────────────────────────────────────────────

  describe('Redis error handler (onModuleInit)', () => {
    it('registers an error listener on the Redis client', () => {
      // onModuleInit() was called during module.init() in beforeEach.
      // The mock Redis `on` method should have been called with 'error'.
      expect(mockRedis.on).toHaveBeenCalledWith('error', expect.any(Function));
    });
  });

  // ── logout ────────────────────────────────────────────────────────────────

  describe('logout', () => {
    it('clears the refreshToken for the given userId', async () => {
      await service.logout('user-uuid-1');

      expect(userRepo.update).toHaveBeenCalledWith('user-uuid-1', { refreshToken: null });
    });
  });
});
