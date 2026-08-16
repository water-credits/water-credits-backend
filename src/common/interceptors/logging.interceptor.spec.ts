import { CallHandler, ExecutionContext, LoggerService } from '@nestjs/common';
import { lastValueFrom, of } from 'rxjs';
import { LoggingInterceptor } from './logging.interceptor';

describe('LoggingInterceptor', () => {
  const logger: jest.Mocked<LoggerService> = {
    log: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
  };

  beforeEach(() => jest.clearAllMocks());

  it('logs structured audit fields for an authenticated mutation request', async () => {
    const setHeader = jest.fn();
    const request = {
      headers: { 'x-request-id': 'request-123' },
      method: 'POST',
      path: '/api/v1/credits/retire',
      url: '/api/v1/credits/retire',
      ip: '192.168.1.42',
      body: { amount: 10 },
      user: { id: 'user-123', wallet: 'GABC123' },
    };
    const response = { statusCode: 201, setHeader };
    const context = {
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => response,
      }),
    } as unknown as ExecutionContext;
    const next: CallHandler = { handle: () => of({ ok: true }) };

    await lastValueFrom(new LoggingInterceptor(logger, 'production').intercept(context, next));

    expect(setHeader).toHaveBeenCalledWith('X-Request-Id', 'request-123');
    expect(logger.log).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'http_request',
        userId: 'user-123',
        wallet: 'GABC123',
        requestId: 'request-123',
        method: 'POST',
        path: '/api/v1/credits/retire',
        statusCode: 201,
        durationMs: expect.any(Number),
        ip: '192.168.1.0',
        bodySize: Buffer.byteLength(JSON.stringify(request.body)),
      }),
      'HTTP',
    );
  });

  it('handles public routes without a user', async () => {
    const request = {
      headers: {},
      method: 'GET',
      path: '/health',
      url: '/health',
      ip: '127.0.0.1',
    };
    const response = { statusCode: 200, setHeader: jest.fn() };
    const context = {
      switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
    } as unknown as ExecutionContext;

    await lastValueFrom(
      new LoggingInterceptor(logger).intercept(context, { handle: () => of('ok') }),
    );

    expect(logger.log).toHaveBeenCalledWith(
      expect.objectContaining({ userId: null, wallet: null, requestId: expect.any(String) }),
      'HTTP',
    );
  });
});
