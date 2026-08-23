import { ServiceUnavailableException } from '@nestjs/common';

/**
 * Thrown when the wallet-auth challenge store (a dedicated Redis instance,
 * see `RedisService`) is unreachable.
 *
 * Before this existed, a Redis outage during `generateChallenge` failed
 * silently (fire-and-forget) and a subsequent `login`/`register` call would
 * GETDEL `null`, producing an ordinary `UnauthorizedException` — visually
 * identical to a wrong signature or expired challenge. That ambiguity is
 * exactly what issue #88 flagged: operators (and users) couldn't tell "you
 * typed the wrong thing" apart from "auth infrastructure is down." This
 * typed 503 makes that distinction explicit.
 */
export class AuthUnavailableException extends ServiceUnavailableException {
  constructor(detail?: string) {
    super({
      statusCode: 503,
      error: 'AuthUnavailable',
      message: 'Wallet authentication is temporarily unavailable. Please try again shortly.',
      ...(detail ? { detail } : {}),
    });
  }
}
