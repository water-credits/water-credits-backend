import {
  Injectable,
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  SetMetadata,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RedisService } from '../redis.service';

export const RATE_LIMIT_KEY = 'rateLimit';
export const RateLimit = (maxRequests: number, windowMs: number) =>
  SetMetadata(RATE_LIMIT_KEY, { maxRequests, windowMs });

@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly logger = new Logger(RateLimitGuard.name);

  /**
   * Atomic sliding-window counter. INCR is atomic, and PEXPIRE is only applied
   * when the key is first created (counter === 1), so the window starts at the
   * first request and the counter resets once the key expires. A single EVAL
   * keeps the whole operation one round-trip with no TOCTOU race.
   */
  private static readonly SLIDING_WINDOW_SCRIPT = `
    local current = redis.call('INCR', KEYS[1])
    if current == 1 then
      redis.call('PEXPIRE', KEYS[1], ARGV[1])
    end
    return current
  `;

  constructor(
    private readonly reflector: Reflector,
    private readonly redisService: RedisService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const limitMeta = this.reflector.getAllAndOverride<{ maxRequests: number; windowMs: number }>(
      RATE_LIMIT_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!limitMeta) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const key = `rl:${request.ip || 'anonymous'}:${context.getHandler().name}`;

    try {
      const count = await this.redisService
        .getClient()
        .eval(RateLimitGuard.SLIDING_WINDOW_SCRIPT, 1, key, limitMeta.windowMs);

      if (Number(count) > limitMeta.maxRequests) {
        throw new HttpException('Too many requests', HttpStatus.TOO_MANY_REQUESTS);
      }
    } catch (err) {
      if (err instanceof HttpException) {
        throw err;
      }
      // Fail open: if Redis is unavailable the guard must not hard-fail auth traffic.
      this.logger.warn(`Redis rate-limit unavailable, allowing request: ${(err as Error).message}`);
    }

    return true;
  }
}
