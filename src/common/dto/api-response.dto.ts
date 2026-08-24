import { PaginatedList } from '../pagination';

/**
 * Machine-readable error codes exposed in the API error envelope.
 *
 * Codes are stable identifiers clients can branch on; never expose internal
 * class names, driver errors, or SQL in this field.
 */
export enum ApiErrorCode {
  BAD_REQUEST = 'BAD_REQUEST',
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  UNAUTHORIZED = 'UNAUTHORIZED',
  FORBIDDEN = 'FORBIDDEN',
  NOT_FOUND = 'NOT_FOUND',
  CONFLICT = 'CONFLICT',
  TOO_MANY_REQUESTS = 'TOO_MANY_REQUESTS',
  DATABASE_ERROR = 'DATABASE_ERROR',
  INTERNAL_SERVER_ERROR = 'INTERNAL_SERVER_ERROR',
}

/** Payload carried under the `error` key of every failed response. */
export interface ApiErrorPayload<TDetails = unknown> {
  code: ApiErrorCode;
  message: string;
  requestId: string;
  details?: TDetails;
}

/**
 * Error half of the documented response envelope (see README → Response Envelope):
 *
 *   { success: false, error: { code, message, requestId, details? } }
 */
export class ApiErrorDto<TDetails = unknown> {
  success: boolean;
  error: ApiErrorPayload<TDetails>;

  static of<TDetails = unknown>(params: {
    code: ApiErrorCode;
    message: string;
    requestId: string;
    details?: TDetails;
  }): ApiErrorDto<TDetails> {
    const error: ApiErrorPayload<TDetails> = {
      code: params.code,
      message: params.message,
      requestId: params.requestId,
    };

    if (params.details !== undefined) {
      error.details = params.details;
    }

    return { success: false, error };
  }
}

export class ApiResponseDto<T = unknown> {
  success: boolean;
  data: T;
  timestamp: string;
  statusCode: number;

  static ok<T>(data: T, statusCode = 200): ApiResponseDto<T> {
    return {
      success: true,
      data,
      timestamp: new Date().toISOString(),
      statusCode,
    };
  }
}

/**
 * Response envelope for paginated list endpoints.
 *
 * The `meta` shape adapts to the pagination mode that produced the page:
 *
 *   • Offset mode → `{ total, page, limit, totalPages }` (unchanged contract).
 *   • Cursor mode → `{ limit, count, nextCursor, hasMore }`.
 *
 * `mode` is always present so clients can branch without guessing. Fields that
 * do not apply to the active mode are omitted rather than set to a misleading
 * default (e.g. cursor responses never carry a fabricated `total`).
 */
export interface PaginationMeta {
  /** Which pagination strategy generated this page. */
  mode: 'offset' | 'cursor';
  /** Page size requested. Always present. */
  limit: number;
  /** Offset mode: total matching rows across all pages. */
  total?: number;
  /** Offset mode: the 1-indexed page returned. */
  page?: number;
  /** Offset mode: total number of pages given `total`/`limit`. */
  totalPages?: number;
  /** Cursor mode: number of items in this page. */
  count?: number;
  /** Cursor mode: opaque cursor to fetch the next page, or `null` at the end. */
  nextCursor?: string | null;
  /** Cursor mode: whether another page exists after this one. */
  hasMore?: boolean;
}

export class PaginatedResponseDto<T = unknown> {
  success: boolean;
  data: T[];
  meta: PaginationMeta;
  timestamp: string;

  /**
   * Build an offset-mode paginated response.
   * @deprecated Prefer {@link PaginatedResponseDto.fromList}, which handles both
   * offset and cursor modes from a single `PaginatedList` produced by the
   * `paginate()` helper.
   */
  static from<T>(data: T[], total: number, page: number, limit: number): PaginatedResponseDto<T> {
    return {
      success: true,
      data,
      meta: {
        mode: 'offset',
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Build a response envelope from the unified {@link PaginatedList} returned by
   * the `paginate()` helper, selecting the correct `meta` shape for whichever
   * mode ran.
   */
  static fromList<T>(result: PaginatedList<T>): PaginatedResponseDto<T> {
    const isCursorMode = result.total === undefined;
    const meta: PaginationMeta = isCursorMode
      ? {
          mode: 'cursor',
          limit: result.limit,
          count: result.data.length,
          nextCursor: result.nextCursor ?? null,
          hasMore: result.hasMore ?? false,
        }
      : {
          mode: 'offset',
          limit: result.limit,
          total: result.total,
          page: result.page ?? 1,
          totalPages: Math.ceil((result.total as number) / result.limit),
        };

    return {
      success: true,
      data: result.data,
      meta,
      timestamp: new Date().toISOString(),
    };
  }
}
