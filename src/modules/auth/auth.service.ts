import {
  Injectable,
  UnauthorizedException,
  ConflictException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import Redis from 'ioredis';
import { User, UserRole } from '../users/entities/user.entity';
import { Keypair } from '@stellar/stellar-sdk';
import { RedisService } from './redis.service';
import { AuthUnavailableException } from './exceptions/auth-unavailable.exception';

const CHALLENGE_TTL_SECONDS = 5 * 60; // 5 minutes
const CHALLENGE_KEY_PREFIX = 'auth:challenge:';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly redisService: RedisService,
  ) {}

  private get redis(): Redis {
    return this.redisService.getClient();
  }

  // ── Challenge ─────────────────────────────────────────────────────────────

  generateChallenge(wallet: string): Promise<{ challenge: string; expiresAt: Date }> {
    const challenge = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + CHALLENGE_TTL_SECONDS * 1000);
    const key = `${CHALLENGE_KEY_PREFIX}${wallet.toLowerCase()}`;

    // Previously fire-and-forget: a failed store here was invisible to the
    // caller, who'd get back a challenge that could never be redeemed and
    // would then see a plain "invalid credentials" on login — indistinguishable
    // from actually getting the signature wrong. Await it and fail loudly
    // instead (#88).
    return this.redis
      .set(key, challenge, 'EX', CHALLENGE_TTL_SECONDS)
      .then(() => ({ challenge, expiresAt }))
      .catch((err) => {
        this.logger.error(`Failed to store challenge in Redis: ${err.message}`);
        throw new AuthUnavailableException();
      });
  }

  // ── Signature validation ───────────────────────────────────────────────────

  /**
   * Atomically fetch + delete the stored challenge for `wallet` (GETDEL is
   * Redis ≥ 6.2, with a GET+DEL fallback for older versions).
   *
   * Distinguishes "Redis is up but doesn't support GETDEL" (a normal,
   * expected fallback) from every other failure mode (connection refused,
   * timeout, offline queue disabled) — the latter is a genuine outage and
   * must not be swallowed into a `null` that callers would otherwise read as
   * "no such challenge" and turn into a misleading 401 (#88).
   */
  private async consumeChallenge(wallet: string): Promise<string | null> {
    const key = `${CHALLENGE_KEY_PREFIX}${wallet.toLowerCase()}`;

    try {
      return await this.redis.getdel(key);
    } catch (err) {
      if (!this.isUnsupportedCommandError(err)) {
        this.logger.error(`Redis unavailable during challenge lookup: ${(err as Error).message}`);
        throw new AuthUnavailableException();
      }

      this.logger.warn(`GETDEL unsupported, falling back to GET+DEL: ${(err as Error).message}`);
      try {
        const value = await this.redis.get(key);
        if (value) {
          await this.redis.del(key);
        }
        return value;
      } catch (fallbackErr) {
        this.logger.error(
          `Redis unavailable during GET+DEL fallback: ${(fallbackErr as Error).message}`,
        );
        throw new AuthUnavailableException();
      }
    }
  }

  /** True only for the "server doesn't know this command" class of error (old Redis). */
  private isUnsupportedCommandError(err: unknown): boolean {
    const message = err instanceof Error ? err.message : String(err);
    return /unknown command/i.test(message);
  }

  async validateStellarSignature(
    wallet: string,
    signature: string,
    challenge: string,
  ): Promise<User | null> {
    const storedChallenge = await this.consumeChallenge(wallet);

    if (!storedChallenge || storedChallenge !== challenge) {
      return null;
    }

    try {
      const keypair = Keypair.fromPublicKey(wallet);
      const valid = keypair.verify(Buffer.from(challenge), Buffer.from(signature, 'hex'));
      if (!valid) {
        return null;
      }

      const user = await this.userRepo.findOne({ where: { wallet, isActive: true } });
      return user ?? null;
    } catch {
      return null;
    }
  }

  // ── Login ─────────────────────────────────────────────────────────────────

  async login(
    wallet: string,
    signature: string,
    challenge: string,
  ): Promise<{ accessToken: string; refreshToken: string; user: Partial<User> }> {
    const user = await this.validateStellarSignature(wallet, signature, challenge);
    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }
    if (!user.isActive) {
      throw new UnauthorizedException('Account is deactivated');
    }

    const tokens = await this.generateTokens(user);
    await this.userRepo.update(user.id, {
      refreshToken: this.hashRefreshToken(tokens.refreshToken),
    });

    const { refreshToken: _, ...safeUser } = user;
    return { ...tokens, user: safeUser };
  }

  // ── Register ──────────────────────────────────────────────────────────────

  async register(
    wallet: string,
    signature: string,
    challenge: string,
    email?: string,
    displayName?: string,
  ): Promise<{ accessToken: string; refreshToken: string; user: Partial<User> }> {
    const storedChallenge = await this.consumeChallenge(wallet);

    if (!storedChallenge || storedChallenge !== challenge) {
      throw new BadRequestException('Invalid or expired challenge');
    }

    try {
      const keypair = Keypair.fromPublicKey(wallet);
      const valid = keypair.verify(Buffer.from(challenge), Buffer.from(signature, 'hex'));
      if (!valid) {
        throw new UnauthorizedException('Invalid signature');
      }
    } catch {
      throw new UnauthorizedException('Invalid signature');
    }

    const existing = await this.userRepo.findOne({ where: { wallet } });
    if (existing) {
      throw new ConflictException('Wallet already registered');
    }

    const user = this.userRepo.create({
      wallet,
      email: email ?? null,
      displayName: displayName ?? null,
      role: UserRole.FARMER,
    });
    await this.userRepo.save(user);

    const tokens = await this.generateTokens(user);
    await this.userRepo.update(user.id, {
      refreshToken: this.hashRefreshToken(tokens.refreshToken),
    });

    const { refreshToken: _, ...safeUser } = user;
    return { ...tokens, user: safeUser };
  }

  // ── Refresh ───────────────────────────────────────────────────────────────

  async refresh(refreshToken: string): Promise<{ accessToken: string; refreshToken: string }> {
    try {
      const secret = this.configService.get<string>('jwt.secret');
      const payload = this.jwtService.verify(refreshToken, { secret });
      // Load user with refreshToken column (select: false on entity)
      const user = await this.userRepo
        .createQueryBuilder('user')
        .select(['user.id', 'user.wallet', 'user.role'])
        .addSelect('user.refreshToken')
        .where('user.id = :id', { id: payload.sub })
        .andWhere('user.isActive = :isActive', { isActive: true })
        .getOne();
      if (
        !user ||
        !user.refreshToken ||
        user.refreshToken !== this.hashRefreshToken(refreshToken)
      ) {
        throw new UnauthorizedException('Invalid refresh token');
      }
      const tokens = await this.generateTokens(user);
      await this.userRepo.update(user.id, {
        refreshToken: this.hashRefreshToken(tokens.refreshToken),
      });
      return tokens;
    } catch {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }
  }

  // ── Logout ────────────────────────────────────────────────────────────────

  async logout(userId: string): Promise<void> {
    await this.userRepo.update(userId, { refreshToken: null });
  }

  // ── Token generation ──────────────────────────────────────────────────────

  private async generateTokens(user: User): Promise<{ accessToken: string; refreshToken: string }> {
    const payload = { sub: user.id, wallet: user.wallet, role: user.role };
    const accessExpiresIn = this.configService.get<string>('jwt.expiration') ?? '7d';
    const refreshExpiresIn = this.configService.get<string>('jwt.refreshExpiration') ?? '30d';
    const secret = this.configService.get<string>('jwt.secret');

    const [accessToken, refreshToken] = await Promise.all([
      this.jwtService.signAsync(payload, { expiresIn: accessExpiresIn }),
      this.jwtService.signAsync(payload, { expiresIn: refreshExpiresIn, secret }),
    ]);
    return { accessToken, refreshToken };
  }

  /**
   * Hash a refresh token using SHA-256 HMAC with the JWT secret.
   *
   * Why HMAC-SHA256 over bcrypt?
   *   The refresh endpoint is the most frequently called auth endpoint after
   *   initial login. bcrypt's adaptive cost (even at 10 rounds) adds tens of
   *   milliseconds of latency per call — measurable at high concurrency.
   *   SHA-256 HMAC completes in microseconds with equivalent security for this
   *   use case, because:
   *     - The HMAC key (JWT secret) is a high-entropy server-side secret.
   *     - An attacker with DB read access cannot reverse the hash without the
   *       key (unlike a password hash where the input is low-entropy).
   *     - Token rotation on every refresh limits the window for any leaked
   *       hash to a single refresh cycle.
   *
   * If the threat model shifts (e.g., the JWT secret is also compromised), a
   * dedicated HMAC key should be introduced via a new env var.
   */
  private hashRefreshToken(token: string): string {
    const secret = this.configService.get<string>('jwt.secret') ?? '';
    return crypto.createHmac('sha256', secret).update(token).digest('hex');
  }
}
