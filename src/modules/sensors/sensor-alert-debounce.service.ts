import { Inject, Injectable } from '@nestjs/common';
import { ThrottlerStorage } from '@nestjs/throttler';

/**
 * Shared alert-storm guard for the sensor anomaly pipeline.
 *
 * Reuses the same Redis-backed `ThrottlerStorage` the WS gateway already
 * uses for connection/subscribe rate limiting (see `throttle.decorator.ts`),
 * so debounce state survives restarts and is consistent across replicas
 * without a new table or cache.
 */
@Injectable()
export class SensorAlertDebounceService {
  constructor(@Inject(ThrottlerStorage) private readonly storage: ThrottlerStorage) {}

  /**
   * Returns true when an alert for `key` was already recorded within the
   * last `windowMs` and should therefore be suppressed. The first call for
   * a given key in a window always returns false (and starts the window).
   */
  async shouldSuppress(key: string, windowMs: number): Promise<boolean> {
    const { totalHits } = await this.storage.increment(`sensor:alert:debounce:${key}`, windowMs);
    return totalHits > 1;
  }
}
