import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  LoggerService,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { Observable, tap } from 'rxjs';
import { anonymiseIp, ensureRequestId, RequestWithContext } from '../utils/request-context.util';

export interface HttpLogEntry {
  event: 'http_request';
  userId: string | null;
  wallet: string | null;
  requestId: string;
  method: string;
  path: string;
  statusCode: number;
  durationMs: number;
  ip: string | null;
  bodySize?: number;
}

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  constructor(
    private readonly logger: LoggerService,
    private readonly nodeEnv: string = process.env.NODE_ENV ?? 'development',
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<RequestWithContext>();
    const response = http.getResponse<Response>();
    const requestId = ensureRequestId(request, response);
    const now = Date.now();

    return next.handle().pipe(
      tap(() => {
        const entry: HttpLogEntry = {
          event: 'http_request',
          userId: request.user?.id ?? request.user?.userId ?? null,
          wallet: request.user?.wallet ?? null,
          requestId,
          method: request.method,
          path: request.path || request.url,
          statusCode: response.statusCode,
          durationMs: Date.now() - now,
          ip: anonymiseIp(request.ip, this.nodeEnv === 'production'),
        };

        if (['POST', 'PATCH', 'DELETE'].includes(request.method.toUpperCase())) {
          entry.bodySize = getBodySize(request);
        }

        this.logger.log(entry, 'HTTP');
      }),
    );
  }
}

function getBodySize(request: Request): number {
  if (request.body === undefined || request.body === null) {
    return 0;
  }

  if (Buffer.isBuffer(request.body)) {
    return request.body.length;
  }

  if (typeof request.body === 'string') {
    return Buffer.byteLength(request.body);
  }

  return Buffer.byteLength(JSON.stringify(request.body));
}
