import { Test, TestingModule } from '@nestjs/testing';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { ChallengeRequestDto, ChallengeResponseDto } from './dto/challenge.dto';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { RefreshDto } from './dto/refresh.dto';
import { AuthResponseDto } from './dto/auth-response.dto';
import { RateLimitGuard } from './guards/rate-limit.guard';

describe('AuthController', () => {
  let controller: AuthController;
  let authService: jest.Mocked<AuthService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        {
          provide: AuthService,
          useValue: {
            generateChallenge: jest.fn(),
            login: jest.fn(),
            register: jest.fn(),
            refresh: jest.fn(),
            logout: jest.fn(),
          },
        },
      ],
    })
      .overrideGuard(RateLimitGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<AuthController>(AuthController);
    authService = module.get<AuthService>(AuthService) as jest.Mocked<AuthService>;
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('challenge', () => {
    it('should call authService.generateChallenge with the wallet and return the result', async () => {
      const dto: ChallengeRequestDto = {
        wallet: 'GABCDEF1234567890123456789012345678901234567890123456',
      };
      const expected: ChallengeResponseDto = {
        challenge: 'abc123',
        expiresAt: new Date('2026-07-20T00:00:00Z'),
      };
      authService.generateChallenge.mockResolvedValue(expected);

      const result = await controller.challenge(dto);

      expect(authService.generateChallenge).toHaveBeenCalledWith(dto.wallet);
      expect(result).toBe(expected);
    });
  });

  describe('login', () => {
    it('should call authService.login with wallet, signature, and challenge', async () => {
      const dto: LoginDto = {
        wallet: 'GABCDEF1234567890123456789012345678901234567890123456',
        signature: 'sig123',
        challenge: 'chal123',
      };
      const expected: AuthResponseDto = {
        accessToken: 'at',
        refreshToken: 'rt',
        user: { id: 'u1' },
      } as AuthResponseDto;
      authService.login.mockResolvedValue(expected);

      const result = await controller.login(dto);

      expect(authService.login).toHaveBeenCalledWith(dto.wallet, dto.signature, dto.challenge);
      expect(result).toBe(expected);
    });
  });

  describe('register', () => {
    it('should call authService.register with wallet, signature, challenge, email, and displayName', async () => {
      const dto: RegisterDto = {
        wallet: 'GABCDEF1234567890123456789012345678901234567890123456',
        signature: 'sig123',
        challenge: 'chal123',
        email: 'user@example.com',
        displayName: 'User',
      };
      const expected: AuthResponseDto = {
        accessToken: 'at',
        refreshToken: 'rt',
        user: { id: 'u1' },
      } as AuthResponseDto;
      authService.register.mockResolvedValue(expected);

      const result = await controller.register(dto);

      expect(authService.register).toHaveBeenCalledWith(
        dto.wallet,
        dto.signature,
        dto.challenge,
        dto.email,
        dto.displayName,
      );
      expect(result).toBe(expected);
    });

    it('should pass undefined for email and displayName when not provided', async () => {
      const dto: RegisterDto = {
        wallet: 'GABCDEF1234567890123456789012345678901234567890123456',
        signature: 'sig123',
        challenge: 'chal123',
      };
      const expected: AuthResponseDto = {
        accessToken: 'at',
        refreshToken: 'rt',
        user: { id: 'u1' },
      } as AuthResponseDto;
      authService.register.mockResolvedValue(expected);

      const result = await controller.register(dto);

      expect(authService.register).toHaveBeenCalledWith(
        dto.wallet,
        dto.signature,
        dto.challenge,
        undefined,
        undefined,
      );
      expect(result).toBe(expected);
    });
  });

  describe('refresh', () => {
    it('should call authService.refresh with the refresh token', async () => {
      const dto: RefreshDto = { refreshToken: 'rt123' };
      const expected = { accessToken: 'new-at', refreshToken: 'new-rt' };
      authService.refresh.mockResolvedValue(expected);

      const result = await controller.refresh(dto);

      expect(authService.refresh).toHaveBeenCalledWith(dto.refreshToken);
      expect(result).toBe(expected);
    });
  });

  describe('logout', () => {
    it('should call authService.logout with the userId from @CurrentUser', async () => {
      const userId = 'user-123';
      authService.logout.mockResolvedValue(undefined);

      await controller.logout(userId);

      expect(authService.logout).toHaveBeenCalledWith(userId);
    });
  });
});
