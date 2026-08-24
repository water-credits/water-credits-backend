import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  LoggerService,
} from '@nestjs/common';
import { EntityNotFoundError, QueryFailedError } from 'typeorm';
import { Response } from 'express';
import { ensureRequestId, RequestWithContext } from '../utils/request-context.util';
import { ApiErrorDto, ApiErrorCode } from '../dto/api-response.dto';

/** Message used for every unhandled server-side failure surfaced to clients. */
const GENERIC_SERVER_ERROR = 'An internal error occurred';

const GENERIC_ENTITY_NOT_FOUND = 'Resource not found';

const VALIDATION_FAILED = 'Validation failed';

/** Safe fallback messages keyed by status — used when an HttpException body carries no usable message. */
const STATUS_FALLBACK_MESSAGES: Record<number, string> = {
  [HttpStatus.BAD_REQUEST]: 'Bad request',
  [HttpStatus.UNAUTHORIZED]: 'Unauthorized',
  [HttpStatus.FORBIDDEN]: 'Forbidden',
  [HttpStatus.NOT_FOUND]: 'Not found',
  [HttpStatus.CONFLICT]: 'Conflict',
  [HttpStatus.TOO_MANY_REQUESTS]: 'Too many requests',
};

const STATUS_TO_CODE: Partial<Record<number, ApiErrorCode>> = {
  [HttpStatus.BAD_REQUEST]: ApiErrorCode.BAD_REQUEST,
  [HttpStatus.UNAUTHORIZED]: ApiErrorCode.UNAUTHORIZED,
  [HttpStatus.FORBIDDEN]: ApiErrorCode.FORBIDDEN,
  [HttpStatus.NOT_FOUND]: ApiErrorCode.NOT_FOUND,
  [HttpStatus.CONFLICT]: ApiErrorCode.CONFLICT,
  [HttpStatus.TOO_MANY_REQUESTS]: ApiErrorCode.TOO_MANY_REQUESTS,
};

interface ResolvedError {
  status: number;
  code: ApiErrorCode;
  message: string;
  details?: unknown;
}

function codeForStatus(status: number): ApiErrorCode {
  return (
    STATUS_TO_CODE[status] ??
    (status >= HttpStatus.INTERNAL_SERVER_ERROR
      ? ApiErrorCode.INTERNAL_SERVER_ERROR
      : ApiErrorCode.BAD_REQUEST)
  );
}

function fallbackMessageForStatus(status: number): string {
  return (
    STATUS_FALLBACK_MESSAGES[status] ??
    (status >= HttpStatus.INTERNAL_SERVER_ERROR ? GENERIC_SERVER_ERROR : 'An error occurred')
  );
}

interface ExceptionBody {
  message?: string | string[];
  error?: string;
}

function isExceptionBody(value: unknown): value is ExceptionBody {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(
    private readonly logger: LoggerService,
    private readonly isProduction = false,
  ) {}

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<RequestWithContext>();
    const requestId = ensureRequestId(request, response);

    const resolved = this.resolve(exception);

    this.logger.error(
      {
        event: 'http_exception',
        requestId,
        method: request.method,
        path: request.path || request.url,
        statusCode: resolved.status,
        code: resolved.code,
        message: exception instanceof Error ? exception.message : String(exception),
        stack: exception instanceof Error ? exception.stack : undefined,
      },
      undefined,
      AllExceptionsFilter.name,
    );

    const body = ApiErrorDto.of({
      code: resolved.code,
      message: resolved.message,
      requestId,
      details: resolved.details,
    });

    response.status(resolved.status).json(body);
  }

  /**
   * Map any thrown value onto the public error envelope. Internal detail
   * (stack traces, driver errors, SQL) never crosses this boundary; it stays
   * in the server-side log where `requestId` correlates it with the response.
   */
  private resolve(exception: unknown): ResolvedError {
    if (exception instanceof QueryFailedError) {
      return {
        status: HttpStatus.INTERNAL_SERVER_ERROR,
        code: ApiErrorCode.DATABASE_ERROR,
        message: GENERIC_SERVER_ERROR,
      };
    }

    if (exception instanceof EntityNotFoundError) {
      return {
        status: HttpStatus.NOT_FOUND,
        code: ApiErrorCode.NOT_FOUND,
        message: GENERIC_ENTITY_NOT_FOUND,
      };
    }

    if (exception instanceof HttpException) {
      return this.resolveHttpException(exception);
    }

    // Unhandled non-HTTP failure. Detail only in development; production gets
    // the generic message so internal states cannot be probed via error output.
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      code: ApiErrorCode.INTERNAL_SERVER_ERROR,
      message:
        !this.isProduction && exception instanceof Error && exception.message
          ? exception.message
          : GENERIC_SERVER_ERROR,
    };
  }

  private resolveHttpException(exception: HttpException): ResolvedError {
    const status = exception.getStatus();
    const exResponse = exception.getResponse();

    let code = codeForStatus(status);
    let message: string;
    let details: unknown;

    if (typeof exResponse === 'string') {
      message = exResponse;
    } else if (!isExceptionBody(exResponse)) {
      message = fallbackMessageForStatus(status);
    } else if (Array.isArray(exResponse.message)) {
      // class-validator pipe shape: { statusCode, error: 'Bad Request', message: string[] }
      message =
        typeof exResponse.error === 'string' && exResponse.error.length > 0
          ? exResponse.error
          : VALIDATION_FAILED;
      code = ApiErrorCode.VALIDATION_ERROR;
      details = exResponse.message;
    } else if (typeof exResponse.message === 'string' && exResponse.message.length > 0) {
      message = exResponse.message;
    } else {
      // Object body without a usable message — serialise nothing from it.
      message = fallbackMessageForStatus(status);
    }

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR && this.isProduction) {
      return {
        status,
        code: ApiErrorCode.INTERNAL_SERVER_ERROR,
        message: GENERIC_SERVER_ERROR,
      };
    }

    return { status, code, message, details };
  }
}
