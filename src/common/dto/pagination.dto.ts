import { IsOptional, IsInt, Min, Max, IsString } from 'class-validator';
import { Type } from 'class-transformer';

/**
 * Standard query-string pagination parameters.
 *
 * Supports two mutually-compatible modes on the same endpoint:
 *
 *   • Offset mode  — `?page=2&limit=20` (the original, backwards-compatible
 *     contract). Simple, exposes a `total`, but duplicates/skips rows under
 *     concurrent writes and degrades on large tables.
 *
 *   • Cursor mode  — `?cursor=<opaque>&limit=20` (keyset/seek pagination).
 *     Stable under concurrent inserts and O(limit) regardless of depth.
 *     When `cursor` is present it takes precedence over `page`.
 *
 * Usage in a controller:
 *   @Get()
 *   findAll(@Query() pagination: PaginationDto) { ... }
 *
 * Usage in a service (TypeORM):
 *   paginate(qb, { alias: 'x', sortColumn: 'x.created_at', sortProperty: 'createdAt' }, pagination)
 */
export class PaginationDto {
  /** 1-indexed page number for offset mode (default: 1). Ignored when `cursor` is set. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  page: number = 1;

  /** Maximum items per page (default: 20, max: 100) */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  @Type(() => Number)
  limit: number = 20;

  /**
   * Opaque keyset cursor from a previous response's `meta.nextCursor`.
   * When present, the endpoint uses cursor (keyset) pagination and `page` is
   * ignored. Treat the value as opaque — do not construct or mutate it.
   */
  @IsOptional()
  @IsString()
  cursor?: string;

  /**
   * Row offset for use with TypeORM's `.skip()`.
   * Derived from `page` and `limit`.
   */
  get skip(): number {
    return (this.page - 1) * this.limit;
  }

  /**
   * Alias for `limit`, for use with TypeORM's `.take()`.
   */
  get take(): number {
    return this.limit;
  }
}
