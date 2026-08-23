/**
 * Single source of truth for the CORS origin policy. `main.ts` (HTTP) and
 * `SensorsGateway` (WebSocket) both read from `corsOptions` so the two
 * transports cannot drift apart — previously the gateway configured its own
 * copy of this logic independently of `app.enableCors()`.
 */
export function resolveCorsOrigin(): string {
  return process.env.NODE_ENV === 'production' ? (process.env.CORS_ORIGIN ?? '') : '*';
}

export const corsOptions = {
  origin: resolveCorsOrigin(),
  credentials: true,
} as const;
