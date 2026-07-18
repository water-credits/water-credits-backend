import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Keypair } from '@stellar/stellar-sdk';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { User, UserRole } from '../users/entities/user.entity';

const mockRedis = {
  get: jest.fn(),
  set: jest.fn().mockResolvedValue('OK'),
  del: jest.fn().mockResolvedValue(1),
  getdel: jest.fn(),
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

describe('AuthController', () => {
  let controller: AuthController;
  let userRepo: {
    findOne: jest.Mock;
    createQueryBuilder: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    update: jest.Mock;
  };

  beforeEach(async () => {
    Object.values(mockRedis).forEach((fn) => {
      if (typeof fn === 'function' && 'mockReset' in fn) {
        (fn as jest.Mock).mockReset();
      }
    });
    mockRedis.set.mockResolvedValue('OK');
    mockRedis.del.mockResolvedValue(1);
    mockRedis.quit.mockResolvedValue('OK');
    mockRedis.on.mockReturnValue(mockRedis);

    userRepo = {
      findOne: jest.fn().mockResolvedValue(null),
      createQueryBuilder: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getOne: jest.fn(),
      }),
      create: jest.fn(),
      save: jest.fn(),
      update: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        AuthService,
        { provide: getRepositoryToken(User), useValue: userRepo },
        { provide: JwtService, useValue: { signAsync: jest.fn().mockResolvedValue('signed-jwt-token') } },
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

    await module.init();
    controller = module.get<AuthController>(AuthController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('handles a challenge → login round-trip with a real Stellar keypair', async () => {
    const keypair = Keypair.random();
    const wallet = keypair.publicKey();
    const user = makeUser({ wallet });

    userRepo.findOne.mockResolvedValue(user);

    const challengeResponse = await controller.challenge({ wallet });
    expect(challengeResponse.challenge).toBeDefined();

    const signature = Buffer.from(keypair.sign(Buffer.from(challengeResponse.challenge))).toString(
      'base64',
    );
    mockRedis.getdel.mockResolvedValue(challengeResponse.challenge);

    const loginResponse = await controller.login({
      wallet,
      signature,
      challenge: challengeResponse.challenge,
    });

    expect(loginResponse.accessToken).toBeDefined();
    expect(loginResponse.user.wallet).toBe(wallet);
  });
});
