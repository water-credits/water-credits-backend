import { randomUUID } from 'crypto';
import { Column, DataSource, Entity, PrimaryColumn, SelectQueryBuilder } from 'typeorm';
import { DataType, newDb } from 'pg-mem';
import { KeysetColumns, paginateKeyset, paginateOffset } from './keyset-paginator';

/**
 * Integration test for keyset pagination against a real (in-memory) PostgreSQL
 * engine — the acceptance criterion from issue #90:
 *
 *   "A test injecting rows concurrently during pagination shows no
 *    duplicates/skips."
 *
 * pg-mem executes the actual SQL our paginator generates (row-comparison
 * predicate, ORDER BY, LIMIT, parameter binding of an ISO timestamp against a
 * timestamptz column), so this exercises the real behaviour rather than a mock.
 * We also run the *same* concurrent-insert scenario through the legacy OFFSET
 * path to demonstrate the duplication bug keyset pagination fixes.
 */
@Entity('paginated_rows')
class PaginatedRow {
  @PrimaryColumn('uuid')
  id: string;

  // Mirrors production sort columns (created_at / timestamp / retired_at).
  @Column({ name: 'sort_at', type: 'timestamptz' })
  sortAt: Date;

  @Column({ type: 'text' })
  label: string;
}

const COLS: KeysetColumns<PaginatedRow> = {
  alias: 'row',
  sortColumn: 'row.sort_at',
  sortProperty: 'sortAt',
};

const BASE = Date.parse('2026-01-01T00:00:00.000Z');

describe('paginateKeyset (integration, pg-mem)', () => {
  let ds: DataSource;

  beforeEach(async () => {
    const db = newDb();
    // TypeORM 0.3's Postgres driver probes these on connect; pg-mem ships very
    // few native functions, so we shim the handful the handshake needs.
    db.public.registerFunction({
      name: 'version',
      returns: DataType.text,
      implementation: () => 'PostgreSQL 14.0 (pg-mem)',
    });
    db.public.registerFunction({
      name: 'current_database',
      returns: DataType.text,
      implementation: () => 'test',
    });
    ds = db.adapters.createTypeormDataSource({
      type: 'postgres',
      entities: [PaginatedRow],
      synchronize: true,
    }) as DataSource;
    // synchronize:true builds the schema during initialize(); a fresh in-memory
    // db per test means no explicit drop/reset is needed.
    await ds.initialize();
  });

  afterEach(async () => {
    if (ds?.isInitialized) {
      await ds.destroy();
    }
  });

  const repo = () => ds.getRepository(PaginatedRow);
  const qb = (): SelectQueryBuilder<PaginatedRow> => repo().createQueryBuilder('row');

  async function insertRow(sortAtMs: number, label: string): Promise<void> {
    await repo().save({ id: randomUUID(), sortAt: new Date(sortAtMs), label });
  }

  /** Seed `count` rows, one per second starting at BASE. */
  async function seedSequential(count: number): Promise<void> {
    for (let i = 0; i < count; i++) {
      await insertRow(BASE + i * 1_000, `seed-${i}`);
    }
  }

  /**
   * Walk every page via keyset, invoking `onAfterPage` between fetches so a test
   * can inject concurrent writes at the exact moment real clients would.
   */
  async function walkKeyset(
    pageSize: number,
    onAfterPage?: (pageIndex: number) => Promise<void>,
  ): Promise<string[]> {
    const ids: string[] = [];
    let cursor: string | undefined;
    let pageIndex = 0;
    for (;;) {
      const page = await paginateKeyset(qb(), COLS, cursor, pageSize);
      ids.push(...page.data.map((r) => r.id));
      if (onAfterPage) {
        await onAfterPage(pageIndex);
      }
      pageIndex++;
      if (!page.hasMore || !page.nextCursor) {
        break;
      }
      cursor = page.nextCursor;
      if (pageIndex > 10_000) {
        throw new Error('keyset pagination failed to terminate');
      }
    }
    return ids;
  }

  it('returns every row exactly once across pages with no concurrent writes', async () => {
    await seedSequential(25);
    const ids = await walkKeyset(10);

    expect(ids).toHaveLength(25);
    expect(new Set(ids).size).toBe(25); // no duplicates
  });

  it('orders strictly by (sort_at DESC, id DESC), including across a tie cluster', async () => {
    // 12 rows share one timestamp so the id tiebreaker is what orders them; the
    // cluster straddles page boundaries at pageSize 5.
    const shared = BASE + 5_000;
    for (let i = 0; i < 12; i++) {
      await insertRow(shared, `tie-${i}`);
    }
    const ids = await walkKeyset(5);

    expect(ids).toHaveLength(12);
    expect(new Set(ids).size).toBe(12); // every tied row seen exactly once

    // Verify the emitted order matches a direct ORDER BY sort_at DESC, id DESC.
    const expected = await qb()
      .orderBy('row.sort_at', 'DESC')
      .addOrderBy('row.id', 'DESC')
      .getMany();
    expect(ids).toEqual(expected.map((r) => r.id));
  });

  it('shows NO duplicates or skips when rows are inserted concurrently mid-pagination', async () => {
    await seedSequential(30);
    const seedIds = (await qb().getMany()).map((r) => r.id);
    expect(seedIds).toHaveLength(30);

    // After each page, insert a fresh newest-row (created "now") — exactly the
    // high-write-rate scenario (sensor readings/oracle submissions) that breaks
    // offset pagination. Newer rows sort *ahead* of the cursor and must never
    // corrupt already-returned pages.
    let concurrentCounter = 0;
    const ids = await walkKeyset(10, async () => {
      await insertRow(
        BASE + 1_000_000 + concurrentCounter * 1_000,
        `concurrent-${concurrentCounter}`,
      );
      concurrentCounter++;
    });

    // Invariant 1 — no duplicates.
    expect(new Set(ids).size).toBe(ids.length);
    // Invariant 2 — no skips: every row that existed at the start is returned.
    for (const seedId of seedIds) {
      expect(ids).toContain(seedId);
    }
    // The forward keyset walk yields a consistent snapshot: the rows inserted
    // ahead of the starting cursor are simply not part of this walk.
    expect(ids).toHaveLength(30);
  });

  it('CONTRAST: the legacy OFFSET path duplicates rows under the same concurrent inserts', async () => {
    await seedSequential(30);

    const ids: string[] = [];
    const pageSize = 10;
    // Page 1.
    const page1 = await paginateOffset(qb(), COLS, 1, pageSize);
    ids.push(...page1.data.map((r) => r.id));

    // Concurrent inserts land at the front (newest) — shifting every subsequent
    // offset window backwards so rows from page 1 reappear on page 2.
    for (let i = 0; i < pageSize; i++) {
      await insertRow(BASE + 1_000_000 + i * 1_000, `concurrent-${i}`);
    }

    // Pages 2 and 3.
    for (let p = 2; p <= 3; p++) {
      const page = await paginateOffset(qb(), COLS, p, pageSize);
      ids.push(...page.data.map((r) => r.id));
    }

    // Offset pagination re-serves already-seen rows: the set is smaller than the
    // list. This is precisely the defect keyset pagination eliminates above.
    expect(new Set(ids).size).toBeLessThan(ids.length);
  });
});
