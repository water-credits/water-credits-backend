import {
  ArgumentsHost,
  BadRequestException,
  HttpException,
  HttpStatus,
  LoggerService,
} from '@nestjs/common';
import { EntityNotFoundError, QueryFailedError } from 'typeorm';
import { Response } from 'express';
import { AllExceptionsFilter } from './all-exceptions.filter';

interface MockResponse {
  status: jest.Mock;
  json: jest.Mock;
  setHeader: jest.Mock;
}

function createHost(requestHeaders: Record<string, string> = {}): {
  host: ArgumentsHost;
  response: MockResponse;
} {
  const request = {
    method: 'GET',
    path: '/api/v1/test',
    url: '/api/v1/test?x=1',
    headers: requestHeaders,
  };
  const response: MockResponse = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    setHeader: jest.fn(),
  };
  const host = {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response as unknown as Response,
    }),
  } as unknown as ArgumentsHost;

  return { host, response };
}

function createFilter(isProduction = false): AllExceptionsFilter {
  const logger = { error: jest.fn() } as unknown as LoggerService;
  return new AllExceptionsFilter(logger, isProduction);
}

describe('AllExceptionsFilter', () => {
  it.each([
    ['HttpException', new BadRequestException(['amount must be a number', 'project must exist'])],
    [
      'QueryFailedError',
      new QueryFailedError(
        'SELECT secret_column FROM users',
        ['param-value'],
        new Error('syntax error at or near'),
      ),
    ],
    ['generic Error', new Error('connection refused to db-host:5432')],
  ])('returns the documented error envelope for %s', (_label, exception) => {
    const filter = createFilter();
    const { host, response } = createHost();

    filter.catch(exception, host);

    expect(response.status).toHaveBeenCalled();
    const body = response.json.mock.calls[0][0];
    expect(body).toMatchObject({ success: false });
    expect(body.error).toHaveProperty('code');
    expect(body.error).toHaveProperty('message');
    expect(body.error).toHaveProperty('requestId');
    expect(typeof body.error.message).toBe('string');
  });

  describe('HttpException branch', () => {
    it('maps class-validator array messages to VALIDATION_ERROR with details', () => {
      const filter = createFilter();
      const { host, response } = createHost();

      filter.catch(
        new BadRequestException(['amount must be a number', 'project must exist']),
        host,
      );

      expect(response.status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
      const body = response.json.mock.calls[0][0];
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('VALIDATION_ERROR');
      expect(body.error.details).toEqual(['amount must be a number', 'project must exist']);
    });

    it('passes through client-facing string messages unchanged', () => {
      const filter = createFilter();
      const { host, response } = createHost();

      filter.catch(new HttpException('Insufficient balance', HttpStatus.CONFLICT), host);

      expect(response.status).toHaveBeenCalledWith(HttpStatus.CONFLICT);
      const body = response.json.mock.calls[0][0];
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('CONFLICT');
      expect(body.error.message).toBe('Insufficient balance');
    });

    it('never serialises an object body without a usable message', () => {
      const filter = createFilter();
      const { host, response } = createHost();

      filter.catch(new HttpException({ reason: 'internal-state' }, 409), host);

      const body = response.json.mock.calls[0][0];
      expect(JSON.stringify(body)).not.toContain('internal-state');
      expect(body.error.message).toBe('Conflict');
    });

    it('hides detail for 5xx HttpExceptions in production', () => {
      const filter = createFilter(true);
      const { host, response } = createHost();

      filter.catch(
        new HttpException({ message: 'upstream ledger unreachable' }, HttpStatus.BAD_GATEWAY),
        host,
      );

      const body = response.json.mock.calls[0][0];
      expect(response.status).toHaveBeenCalledWith(HttpStatus.BAD_GATEWAY);
      expect(body.error.message).toBe('An internal error occurred');
      expect(body.error.code).toBe('INTERNAL_SERVER_ERROR');
    });

    it('keeps developer detail for 5xx HttpExceptions outside production', () => {
      const filter = createFilter(false);
      const { host, response } = createHost();

      filter.catch(
        new HttpException({ message: 'upstream ledger unreachable' }, HttpStatus.BAD_GATEWAY),
        host,
      );

      const body = response.json.mock.calls[0][0];
      expect(body.error.message).toBe('upstream ledger unreachable');
    });
  });

  describe('QueryFailedError branch', () => {
    it('maps to DATABASE_ERROR with a generic message and no SQL or params', () => {
      const filter = createFilter();
      const { host, response } = createHost();

      filter.catch(
        new QueryFailedError(
          'SELECT secret_column FROM water_rights WHERE holder = $1',
          ['wallet-secret-param'],
          new Error('relation "water_rights" does not exist'),
        ),
        host,
      );

      expect(response.status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
      const raw = JSON.stringify(response.json.mock.calls[0][0]);
      expect(raw).not.toContain('secret_column');
      expect(raw).not.toContain('wallet-secret-param');
      expect(raw).not.toContain('does not exist');

      const body = response.json.mock.calls[0][0];
      expect(body.error.code).toBe('DATABASE_ERROR');
      expect(body.error.message).toBe('An internal error occurred');
    });
  });

  describe('EntityNotFoundError branch', () => {
    it('maps to 404 NOT_FOUND without leaking entity metadata', () => {
      const filter = createFilter();
      const { host, response } = createHost();

      filter.catch(new EntityNotFoundError('UserEntity', { id: 'u-1' }), host);

      expect(response.status).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
      const body = response.json.mock.calls[0][0];
      expect(body.error.code).toBe('NOT_FOUND');
      expect(body.error.message).toBe('Resource not found');
      expect(JSON.stringify(body)).not.toContain('UserEntity');
    });
  });

  describe('generic Error branch', () => {
    it('hides the underlying message in production', () => {
      const filter = createFilter(true);
      const { host, response } = createHost();

      filter.catch(new Error('connect ECONNREFUSED 10.0.0.4:5432'), host);

      const body = response.json.mock.calls[0][0];
      expect(response.status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
      expect(body.error.code).toBe('INTERNAL_SERVER_ERROR');
      expect(body.error.message).toBe('An internal error occurred');
      expect(JSON.stringify(body)).not.toContain('ECONNREFUSED');
    });

    it('exposes the underlying message in development', () => {
      const filter = createFilter(false);
      const { host, response } = createHost();

      filter.catch(new Error('connect ECONNREFUSED 10.0.0.4:5432'), host);

      const body = response.json.mock.calls[0][0];
      expect(body.error.message).toBe('connect ECONNREFUSED 10.0.0.4:5432');
    });
  });

  describe('requestId correlation', () => {
    it('reuses the x-request-id header when supplied and echoes it on the response header', () => {
      const filter = createFilter();
      const { host, response } = createHost({ 'x-request-id': 'req-abc-123' });

      filter.catch(new Error('boom'), host);

      expect(response.setHeader).toHaveBeenCalledWith('X-Request-Id', 'req-abc-123');
      const body = response.json.mock.calls[0][0];
      expect(body.error.requestId).toBe('req-abc-123');
    });

    it('generates a UUID requestId when no header is present', () => {
      const filter = createFilter();
      const { host, response } = createHost();

      filter.catch(new Error('boom'), host);

      const body = response.json.mock.calls[0][0];
      expect(body.error.requestId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
    });
  });
});
