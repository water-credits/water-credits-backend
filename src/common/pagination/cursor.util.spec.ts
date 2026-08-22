import {
  decodeCursor,
  encodeCursor,
  InvalidCursorException,
  serialiseSortValue,
} from './cursor.util';

describe('cursor.util', () => {
  describe('encode/decode round-trip', () => {
    it('round-trips a (sortValue, id) tuple losslessly', () => {
      const payload = { v: '2026-08-22T10:00:00.000Z', id: 'abc-123' };
      const decoded = decodeCursor(encodeCursor(payload));
      expect(decoded).toEqual(payload);
    });

    it('produces a URL-safe token (base64url — no +, /, or = padding)', () => {
      // A payload chosen so its base64 form would contain + and / (which
      // base64url replaces with - and _), proving the URL-safe alphabet.
      const token = encodeCursor({ v: '2026-08-22T10:00:00.000Z>>>???', id: 'ÿÿ-id' });
      expect(token).not.toMatch(/[+/=]/);
      expect(decodeCursor(token)).toEqual({ v: '2026-08-22T10:00:00.000Z>>>???', id: 'ÿÿ-id' });
    });

    it('treats the token as opaque and does not leak a readable value at a glance', () => {
      const token = encodeCursor({ v: '2026-08-22T10:00:00.000Z', id: 'abc-123' });
      expect(token).not.toContain('abc-123');
    });
  });

  describe('decodeCursor validation', () => {
    it.each([
      ['not valid base64url at all', '!!!not-base64!!!'],
      ['valid base64url but not JSON', Buffer.from('hello', 'utf8').toString('base64url')],
      ['JSON missing the id field', Buffer.from(JSON.stringify({ v: 'x' })).toString('base64url')],
      ['JSON missing the v field', Buffer.from(JSON.stringify({ id: 'x' })).toString('base64url')],
      [
        'JSON with non-string fields',
        Buffer.from(JSON.stringify({ v: 1, id: 2 })).toString('base64url'),
      ],
      ['a JSON array', Buffer.from(JSON.stringify(['x', 'y'])).toString('base64url')],
      ['JSON null', Buffer.from(JSON.stringify(null)).toString('base64url')],
    ])('throws InvalidCursorException for %s', (_desc, cursor) => {
      expect(() => decodeCursor(cursor)).toThrow(InvalidCursorException);
    });

    it('maps to an HTTP 400 (BadRequest) so a tampered cursor is a client error', () => {
      let status: number | undefined;
      try {
        decodeCursor('%%%');
      } catch (err) {
        status = (err as InvalidCursorException).getStatus();
      }
      expect(status).toBe(400);
    });
  });

  describe('serialiseSortValue', () => {
    it('serialises Date to ISO-8601 (round-trips through timestamptz)', () => {
      const d = new Date('2026-08-22T10:00:00.000Z');
      expect(serialiseSortValue(d)).toBe('2026-08-22T10:00:00.000Z');
    });

    it('coerces numbers and strings with String()', () => {
      expect(serialiseSortValue(42)).toBe('42');
      expect(serialiseSortValue('already-a-string')).toBe('already-a-string');
    });

    it('rejects null/undefined sort values (they cannot be positioned)', () => {
      expect(() => serialiseSortValue(null)).toThrow();
      expect(() => serialiseSortValue(undefined)).toThrow();
    });
  });
});
