import { BadRequestException } from '@nestjs/common';

/**
 * Opaque keyset-pagination cursor.
 *
 * A cursor is a base64url-encoded snapshot of the *last row returned* on the
 * previous page, expressed as the `(sortValue, id)` tuple that our keyset
 * queries order by.  Callers must treat it as an opaque token — the encoding
 * is an implementation detail and may change without notice.
 *
 * Why `(sortValue, id)` and not just `sortValue`?  The sort column (e.g.
 * `created_at`, `timestamp`) is not unique, so ordering by it alone is
 * non-deterministic when rows share a value.  The immutable primary key `id`
 * is appended as a total-order tiebreaker, which is what makes keyset
 * pagination stable under concurrent inserts.
 */
export interface CursorPayload {
  /**
   * The primary sort value of the last row on the previous page, serialised to
   * a string.  Dates are stored as ISO-8601 so PostgreSQL can transparently
   * cast the bound parameter back to `timestamptz`.
   */
  v: string;
  /** The primary-key (`id`) tiebreaker of the last row on the previous page. */
  id: string;
}

/**
 * Thrown when a client supplies a cursor that is not valid base64url, does not
 * decode to JSON, or is missing the expected fields.  Surfaces as HTTP 400 so a
 * tampered/stale cursor is a client error rather than a 500.
 */
export class InvalidCursorException extends BadRequestException {
  constructor() {
    super('Invalid pagination cursor');
  }
}

/**
 * Normalise a raw entity sort value into the string form stored in a cursor.
 *
 * `Date` → ISO-8601 (round-trips losslessly through PostgreSQL `timestamptz`).
 * Everything else is coerced with `String()`; `null`/`undefined` are rejected
 * because a row with a null sort key can never be positioned deterministically.
 */
export function serialiseSortValue(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value === null || value === undefined) {
    throw new Error('Cannot build a pagination cursor from a null sort value');
  }
  return String(value);
}

/** Encode a `(sortValue, id)` tuple into an opaque, URL-safe cursor string. */
export function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/**
 * Decode an opaque cursor back into its `(sortValue, id)` tuple.
 *
 * @throws {InvalidCursorException} if the token is malformed in any way.
 */
export function decodeCursor(cursor: string): CursorPayload {
  let parsed: unknown;
  try {
    const json = Buffer.from(cursor, 'base64url').toString('utf8');
    parsed = JSON.parse(json);
  } catch {
    throw new InvalidCursorException();
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as CursorPayload).v !== 'string' ||
    typeof (parsed as CursorPayload).id !== 'string'
  ) {
    throw new InvalidCursorException();
  }

  return parsed as CursorPayload;
}
