import { ObjectLiteral, SelectQueryBuilder } from 'typeorm';
import { decodeCursor, encodeCursor, serialiseSortValue } from './cursor.util';

export type SortDirection = 'ASC' | 'DESC';

/**
 * Description of the total order a list endpoint paginates over.
 *
 * `sortColumn`/`idColumn` are the SQL expressions used in `ORDER BY` and the
 * keyset `WHERE` predicate (e.g. `reading.timestamp`, `reading.id`).
 * `sortProperty`/`idProperty` are the entity property names read back off a
 * result row to build the next cursor (e.g. `timestamp`, `id`).
 */
export interface KeysetColumns<T> {
  /** QueryBuilder alias of the root entity (e.g. `reading`). */
  alias: string;
  /** SQL expression for the primary sort column (e.g. `reading.timestamp`). */
  sortColumn: string;
  /** Entity property backing `sortColumn` (e.g. `timestamp`). */
  sortProperty: keyof T & string;
  /** SQL expression for the tiebreaker column. Defaults to `<alias>.id`. */
  idColumn?: string;
  /** Entity property backing `idColumn`. Defaults to `id`. */
  idProperty?: keyof T & string;
  /** Sort direction. Defaults to `DESC` (newest-first), matching all callers. */
  direction?: SortDirection;
}

/** The pagination inputs a caller may supply (offset *or* cursor mode). */
export interface PaginationParams {
  /** Opaque keyset cursor. When present, cursor mode is used. */
  cursor?: string;
  /** 1-indexed page number for offset mode. Defaults to 1. */
  page?: number;
  /** Page size. Defaults to 20. */
  limit?: number;
}

/**
 * Unified list result. Offset mode populates `total`/`page`; cursor mode
 * populates `nextCursor`/`hasMore`. `limit` and `data` are always present.
 */
export interface PaginatedList<T> {
  data: T[];
  limit: number;
  /** Offset mode only: total matching rows. */
  total?: number;
  /** Offset mode only: the page that was returned. */
  page?: number;
  /** Cursor mode only: token for the next page, or `null` at the end. */
  nextCursor?: string | null;
  /** Cursor mode only: whether another page exists after this one. */
  hasMore?: boolean;
}

function resolveIdColumn<T>(cols: KeysetColumns<T>): string {
  return cols.idColumn ?? `${cols.alias}.id`;
}

/**
 * Apply a stable, deterministic total ordering to a QueryBuilder:
 * `ORDER BY <sortColumn> <dir>, <idColumn> <dir>`.
 *
 * The `id` tiebreaker guarantees a strict total order even when the sort
 * column has duplicate values — a prerequisite for both correct keyset
 * pagination and reproducible offset pages.
 */
function applyOrdering<T extends ObjectLiteral>(
  qb: SelectQueryBuilder<T>,
  cols: KeysetColumns<T>,
): void {
  const direction = cols.direction ?? 'DESC';
  qb.orderBy(cols.sortColumn, direction).addOrderBy(resolveIdColumn(cols), direction);
}

/**
 * Keyset (a.k.a. seek) pagination over a prepared QueryBuilder.
 *
 * Instead of `OFFSET n` — which re-counts from the top on every page and
 * therefore duplicates or skips rows when concurrent writes shift the offset —
 * this seeks directly to the row *after* the cursor using an indexed range
 * scan:
 *
 * ```sql
 *   WHERE (sort < :v OR (sort = :v AND id < :id))   -- DESC
 *   ORDER BY sort DESC, id DESC
 *   LIMIT :limit + 1
 * ```
 *
 * The predicate is written in expanded boolean form rather than PostgreSQL's
 * row-value syntax `(sort, id) < (:v, :id)` so it is portable and the planner
 * can satisfy it with a composite `(sort, id)` btree index. We fetch one extra
 * row (`limit + 1`) purely to determine `hasMore` without a second query.
 *
 * The caller is responsible for all filtering (`WHERE project_id = …`, date
 * ranges, joins, etc.) *before* calling this; ordering and the cursor predicate
 * are applied here.
 */
export async function paginateKeyset<T extends ObjectLiteral>(
  qb: SelectQueryBuilder<T>,
  cols: KeysetColumns<T>,
  cursor: string | undefined,
  limit: number,
): Promise<PaginatedList<T>> {
  const direction = cols.direction ?? 'DESC';
  const idColumn = resolveIdColumn(cols);
  const idProperty = (cols.idProperty ?? 'id') as keyof T & string;

  if (cursor) {
    const { v, id } = decodeCursor(cursor);
    // `<` walks a DESC (newest-first) list forward; `>` walks an ASC list.
    const cmp = direction === 'DESC' ? '<' : '>';
    qb.andWhere(
      `(${cols.sortColumn} ${cmp} :__cursorValue OR ` +
        `(${cols.sortColumn} = :__cursorValue AND ${idColumn} ${cmp} :__cursorId))`,
      { __cursorValue: v, __cursorId: id },
    );
  }

  applyOrdering(qb, cols);
  // Over-fetch by one so we can report `hasMore` without a COUNT round-trip.
  qb.take(limit + 1);

  const rows = await qb.getMany();
  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;

  let nextCursor: string | null = null;
  if (hasMore && data.length > 0) {
    const last = data[data.length - 1];
    nextCursor = encodeCursor({
      v: serialiseSortValue(last[cols.sortProperty]),
      id: String(last[idProperty]),
    });
  }

  return { data, limit, nextCursor, hasMore };
}

/**
 * Legacy offset/limit pagination over a prepared QueryBuilder.
 *
 * Retained so existing `?page=&limit=` callers keep working unchanged. Ordering
 * now includes the `id` tiebreaker so pages are at least internally
 * deterministic, but offset remains inherently inconsistent under concurrent
 * writes — prefer cursor mode for high-volume lists.
 */
export async function paginateOffset<T extends ObjectLiteral>(
  qb: SelectQueryBuilder<T>,
  cols: KeysetColumns<T>,
  page: number,
  limit: number,
): Promise<PaginatedList<T>> {
  applyOrdering(qb, cols);
  qb.skip((page - 1) * limit).take(limit);

  const [data, total] = await qb.getManyAndCount();
  return { data, limit, total, page };
}

/**
 * Paginate a prepared QueryBuilder, choosing keyset mode when a `cursor` is
 * supplied and falling back to offset mode otherwise. This is the single entry
 * point list services should call.
 */
export async function paginate<T extends ObjectLiteral>(
  qb: SelectQueryBuilder<T>,
  cols: KeysetColumns<T>,
  params: PaginationParams,
): Promise<PaginatedList<T>> {
  const limit = params.limit ?? 20;

  if (params.cursor) {
    return paginateKeyset(qb, cols, params.cursor, limit);
  }

  return paginateOffset(qb, cols, params.page ?? 1, limit);
}
