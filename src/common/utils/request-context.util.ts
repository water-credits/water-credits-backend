import { randomUUID } from 'crypto';
import { Request, Response } from 'express';

export interface RequestWithContext extends Request {
  requestId?: string;
  user?: {
    id?: string;
    userId?: string;
    wallet?: string;
  };
}

export function ensureRequestId(request: RequestWithContext, response: Response): string {
  const header = request.headers['x-request-id'];
  const suppliedRequestId = Array.isArray(header) ? header[0] : header;
  const requestId = suppliedRequestId?.trim() || request.requestId || randomUUID();

  request.requestId = requestId;
  response.setHeader('X-Request-Id', requestId);

  return requestId;
}

export function anonymiseIp(ip: string | undefined, isProduction: boolean): string | null {
  if (!ip) {
    return null;
  }

  if (!isProduction) {
    return ip;
  }

  const ipv4Match = ip.match(/^(.*:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    return `${ipv4Match[1] ?? ''}${ipv4Match[2]}.${ipv4Match[3]}.${ipv4Match[4]}.0`;
  }

  // IPv6 has no octets; clear its final 16-bit segment for equivalent anonymisation.
  const finalColon = ip.lastIndexOf(':');
  return finalColon >= 0 ? `${ip.slice(0, finalColon + 1)}0` : ip;
}
