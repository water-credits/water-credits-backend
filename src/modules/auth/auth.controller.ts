import { Controller, Post, Body, UseGuards, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { ChallengeRequestDto, ChallengeResponseDto } from './dto/challenge.dto';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { RefreshDto } from './dto/refresh.dto';
import { AuthResponseDto } from './dto/auth-response.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { RateLimitGuard, RateLimit } from './guards/rate-limit.guard';
import { ThrottlePublic, SkipThrottle } from '../../common/decorators/throttle.decorator';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @ThrottlePublic()
  @UseGuards(RateLimitGuard)
  @RateLimit(10, 60_000)
  @ApiOperation({ summary: 'Request a Stellar wallet signing challenge' })
  @Post('challenge')
  @HttpCode(HttpStatus.OK)
  async challenge(@Body() dto: ChallengeRequestDto): Promise<ChallengeResponseDto> {
    return this.authService.generateChallenge(dto.wallet);
  }

  @Public()
  @ThrottlePublic()
  @UseGuards(RateLimitGuard)
  @RateLimit(60, 60_000)
  @ApiOperation({ summary: 'Verify a signed challenge and obtain JWTs' })
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(@Body() dto: LoginDto): Promise<AuthResponseDto> {
    return this.authService.login(dto.wallet, dto.signature, dto.challenge);
  }

  @Public()
  @ThrottlePublic()
  @UseGuards(RateLimitGuard)
  @RateLimit(60, 60_000)
  @ApiOperation({ summary: 'Register a new user with a Stellar wallet' })
  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  async register(@Body() dto: RegisterDto): Promise<AuthResponseDto> {
    return this.authService.register(
      dto.wallet,
      dto.signature,
      dto.challenge,
      dto.email,
      dto.displayName,
    );
  }

  @Public()
  @UseGuards(RateLimitGuard)
  @RateLimit(60, 60_000)
  @ApiOperation({ summary: 'Rotate JWTs using a refresh token' })
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(@Body() dto: RefreshDto): Promise<{ accessToken: string; refreshToken: string }> {
    return this.authService.refresh(dto.refreshToken);
  }

  @ApiBearerAuth()
  @ApiOperation({ summary: 'Invalidate the current session' })
  @Post('logout')
  @SkipThrottle()
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(@CurrentUser('id') userId: string): Promise<void> {
    return this.authService.logout(userId);
  }
}
