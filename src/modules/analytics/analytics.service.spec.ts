import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AnalyticsService } from './analytics.service';
import { RedisCacheService } from './redis-cache.service';
import { Project, ProjectStatus } from '../projects/entities/project.entity';
import { Retirement } from '../credits/entities/retirement.entity';
import { ReadingBatch, BatchStatus } from '../sensors/entities/reading-batch.entity';
import { User } from '../users/entities/user.entity';

// ── Typed mock factories ──────────────────────────────────────────────────────

type QueryBuilderMock = {
  select: jest.Mock;
  addSelect: jest.Mock;
  where: jest.Mock;
  andWhere: jest.Mock;
  groupBy: jest.Mock;
  addGroupBy: jest.Mock;
  orderBy: jest.Mock;
  limit: jest.Mock;
  innerJoin: jest.Mock;
  getRawMany: jest.Mock;
  getRawOne: jest.Mock;
};

function makeQueryBuilder(): QueryBuilderMock {
  const qb: Record<string, jest.Mock> = {};
  qb.select = jest.fn().mockReturnValue(qb);
  qb.addSelect = jest.fn().mockReturnValue(qb);
  qb.where = jest.fn().mockReturnValue(qb);
  qb.andWhere = jest.fn().mockReturnValue(qb);
  qb.groupBy = jest.fn().mockReturnValue(qb);
  qb.addGroupBy = jest.fn().mockReturnValue(qb);
  qb.orderBy = jest.fn().mockReturnValue(qb);
  qb.limit = jest.fn().mockReturnValue(qb);
  qb.innerJoin = jest.fn().mockReturnValue(qb);
  qb.getRawMany = jest.fn();
  qb.getRawOne = jest.fn();
  return qb as unknown as QueryBuilderMock;
}

function makeProjectRepo() {
  return {
    count: jest.fn(),
    createQueryBuilder: jest.fn(() => makeQueryBuilder()),
  };
}

function makeRetirementRepo() {
  return {
    createQueryBuilder: jest.fn(() => makeQueryBuilder()),
  };
}

function makeReadingBatchRepo() {
  return {
    createQueryBuilder: jest.fn(() => makeQueryBuilder()),
  };
}

function makeUserRepo() {
  return {};
}

function makeRedisCacheService() {
  const store = new Map<string, unknown>();
  return {
    get: jest.fn(async <T>(key: string): Promise<T | null> => {
      return (store.get(key) as T) ?? null;
    }),
    set: jest.fn(async <T>(key: string, value: T): Promise<void> => {
      store.set(key, value);
    }),
    clear: jest.fn(async (_pattern: string = 'analytics:*'): Promise<void> => {
      store.clear();
    }),
    _store: store,
  };
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('AnalyticsService', () => {
  let service: AnalyticsService;
  let projectRepo: ReturnType<typeof makeProjectRepo>;
  let retirementRepo: ReturnType<typeof makeRetirementRepo>;
  let readingBatchRepo: ReturnType<typeof makeReadingBatchRepo>;
  let cacheService: ReturnType<typeof makeRedisCacheService>;

  beforeEach(async () => {
    projectRepo = makeProjectRepo();
    retirementRepo = makeRetirementRepo();
    readingBatchRepo = makeReadingBatchRepo();
    cacheService = makeRedisCacheService();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AnalyticsService,
        { provide: getRepositoryToken(Project), useValue: projectRepo },
        { provide: getRepositoryToken(Retirement), useValue: retirementRepo },
        { provide: getRepositoryToken(ReadingBatch), useValue: readingBatchRepo },
        { provide: getRepositoryToken(User), useValue: makeUserRepo() },
        { provide: RedisCacheService, useValue: cacheService },
      ],
    }).compile();

    service = module.get<AnalyticsService>(AnalyticsService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  // ── Cache behaviour ─────────────────────────────────────────────────────

  describe('caching', () => {
    beforeEach(async () => {
      await service.clearCache();
    });

    it('serves getOverview from cache on second call', async () => {
      projectRepo.count.mockResolvedValueOnce(10);
      projectRepo.count.mockResolvedValueOnce(5);

      const batchQb = makeQueryBuilder();
      batchQb.getRawOne.mockResolvedValue({ total: '1000' });
      readingBatchRepo.createQueryBuilder.mockReturnValueOnce(batchQb);

      const retirementQb = makeQueryBuilder();
      retirementQb.getRawOne.mockResolvedValue({ total: '500' });
      retirementRepo.createQueryBuilder.mockReturnValueOnce(retirementQb);

      const first = await service.getOverview();
      expect(projectRepo.count).toHaveBeenCalledTimes(2);
      expect(cacheService.set).toHaveBeenCalledWith('analytics:overview', first);

      const second = await service.getOverview();
      expect(second).toEqual(first);
      // Repos should NOT be called again — cache hit
      expect(projectRepo.count).toHaveBeenCalledTimes(2);
    });

    it('clearCache forces a fresh DB query', async () => {
      projectRepo.count.mockResolvedValueOnce(1);
      projectRepo.count.mockResolvedValueOnce(0);

      const batchQb = makeQueryBuilder();
      batchQb.getRawOne.mockResolvedValue({ total: '0' });
      readingBatchRepo.createQueryBuilder.mockReturnValueOnce(batchQb);

      const retirementQb = makeQueryBuilder();
      retirementQb.getRawOne.mockResolvedValue({ total: '0' });
      retirementRepo.createQueryBuilder.mockReturnValueOnce(retirementQb);

      await service.getOverview();
      expect(projectRepo.count).toHaveBeenCalledTimes(2);

      await service.clearCache();
      expect(cacheService.clear).toHaveBeenCalledWith('analytics:*');

      projectRepo.count.mockResolvedValueOnce(2);
      projectRepo.count.mockResolvedValueOnce(1);

      const batchQb2 = makeQueryBuilder();
      batchQb2.getRawOne.mockResolvedValue({ total: '500' });
      readingBatchRepo.createQueryBuilder.mockReturnValueOnce(batchQb2);

      const retirementQb2 = makeQueryBuilder();
      retirementQb2.getRawOne.mockResolvedValue({ total: '200' });
      retirementRepo.createQueryBuilder.mockReturnValueOnce(retirementQb2);

      const fresh = await service.getOverview();
      expect(projectRepo.count).toHaveBeenCalledTimes(4);
      expect(fresh.totalProjects).toBe(2);
    });

    it('serves getCreditsOverTime from cache on second call', async () => {
      const batchQb = makeQueryBuilder();
      batchQb.getRawMany.mockResolvedValue([{ month: '2026-01-01', amount: '100' }]);
      readingBatchRepo.createQueryBuilder.mockReturnValueOnce(batchQb);

      const retirementQb = makeQueryBuilder();
      retirementQb.getRawMany.mockResolvedValue([{ month: '2026-01-01', amount: '50' }]);
      retirementRepo.createQueryBuilder.mockReturnValueOnce(retirementQb);

      const first = await service.getCreditsOverTime();
      expect(readingBatchRepo.createQueryBuilder).toHaveBeenCalledTimes(1);

      const second = await service.getCreditsOverTime();
      expect(second).toEqual(first);
      expect(readingBatchRepo.createQueryBuilder).toHaveBeenCalledTimes(1);
    });

    it('serves getProjectDistribution from cache on second call', async () => {
      const statusQb = makeQueryBuilder();
      statusQb.getRawMany.mockResolvedValue([{ status: 'active', count: '1' }]);
      const methodologyQb = makeQueryBuilder();
      methodologyQb.getRawMany.mockResolvedValue([{ methodology: 'VM0036', count: '1' }]);

      projectRepo.createQueryBuilder
        .mockReturnValueOnce(statusQb)
        .mockReturnValueOnce(methodologyQb);

      const first = await service.getProjectDistribution();
      expect(projectRepo.createQueryBuilder).toHaveBeenCalledTimes(2);

      const second = await service.getProjectDistribution();
      expect(second).toEqual(first);
      expect(projectRepo.createQueryBuilder).toHaveBeenCalledTimes(2);
    });

    it('serves getRetirementByPurpose from cache on second call', async () => {
      const qb = makeQueryBuilder();
      qb.getRawMany.mockResolvedValue([{ purpose: 'voluntary', amount: '1000' }]);
      retirementRepo.createQueryBuilder.mockReturnValueOnce(qb);

      const first = await service.getRetirementByPurpose();
      expect(retirementRepo.createQueryBuilder).toHaveBeenCalledTimes(1);

      const second = await service.getRetirementByPurpose();
      expect(second).toEqual(first);
      expect(retirementRepo.createQueryBuilder).toHaveBeenCalledTimes(1);
    });

    it('serves getTopProjects from cache on second call', async () => {
      const qb = makeQueryBuilder();
      qb.getRawMany.mockResolvedValue([{ id: 'p1', name: 'Proj', totalGenerated: '500' }]);
      readingBatchRepo.createQueryBuilder.mockReturnValueOnce(qb);

      const first = await service.getTopProjects(5);
      expect(readingBatchRepo.createQueryBuilder).toHaveBeenCalledTimes(1);

      const second = await service.getTopProjects(5);
      expect(second).toEqual(first);
      expect(readingBatchRepo.createQueryBuilder).toHaveBeenCalledTimes(1);
    });

    it('serves getTopRetirees from cache on second call', async () => {
      const qb = makeQueryBuilder();
      qb.getRawMany.mockResolvedValue([{ id: 'u1', name: 'User', totalRetired: '200' }]);
      retirementRepo.createQueryBuilder.mockReturnValueOnce(qb);

      const first = await service.getTopRetirees(5);
      expect(retirementRepo.createQueryBuilder).toHaveBeenCalledTimes(1);

      const second = await service.getTopRetirees(5);
      expect(second).toEqual(first);
      expect(retirementRepo.createQueryBuilder).toHaveBeenCalledTimes(1);
    });

    it('falls through to DB when cache get fails or returns null', async () => {
      cacheService.get.mockResolvedValueOnce(null);
      projectRepo.count.mockResolvedValueOnce(5);
      projectRepo.count.mockResolvedValueOnce(2);

      const batchQb = makeQueryBuilder();
      batchQb.getRawOne.mockResolvedValue({ total: '100' });
      readingBatchRepo.createQueryBuilder.mockReturnValueOnce(batchQb);

      const retirementQb = makeQueryBuilder();
      retirementQb.getRawOne.mockResolvedValue({ total: '50' });
      retirementRepo.createQueryBuilder.mockReturnValueOnce(retirementQb);

      const result = await service.getOverview();
      expect(result.totalProjects).toBe(5);
      expect(projectRepo.count).toHaveBeenCalledTimes(2);
    });
  });

  // ── getOverview ──────────────────────────────────────────────────────────

  describe('getOverview', () => {
    it('returns aggregated overview data', async () => {
      projectRepo.count.mockResolvedValueOnce(42);

      projectRepo.count.mockResolvedValueOnce(12);

      const batchQb = makeQueryBuilder();
      batchQb.getRawOne.mockResolvedValue({ total: '150000' });
      readingBatchRepo.createQueryBuilder.mockReturnValueOnce(batchQb);

      const retirementQb = makeQueryBuilder();
      retirementQb.getRawOne.mockResolvedValue({ total: '75000.5' });
      retirementRepo.createQueryBuilder.mockReturnValueOnce(retirementQb);

      const result = await service.getOverview();

      expect(result).toEqual({
        totalProjects: 42,
        activeProjects: 12,
        totalCreditsMinted: 150000,
        totalCreditsRetired: 75000.5,
      });

      expect(projectRepo.count).toHaveBeenCalledTimes(2);
      expect(projectRepo.count).toHaveBeenNthCalledWith(1);
      expect(projectRepo.count).toHaveBeenNthCalledWith(2, {
        where: { status: ProjectStatus.ACTIVE },
      });
    });

    it('returns zero credits when no data exists', async () => {
      projectRepo.count.mockResolvedValueOnce(0);
      projectRepo.count.mockResolvedValueOnce(0);

      const batchQb = makeQueryBuilder();
      batchQb.getRawOne.mockResolvedValue(null);
      readingBatchRepo.createQueryBuilder.mockReturnValueOnce(batchQb);

      const retirementQb = makeQueryBuilder();
      retirementQb.getRawOne.mockResolvedValue(null);
      retirementRepo.createQueryBuilder.mockReturnValueOnce(retirementQb);

      const result = await service.getOverview();

      expect(result).toEqual({
        totalProjects: 0,
        activeProjects: 0,
        totalCreditsMinted: 0,
        totalCreditsRetired: 0,
      });
    });

    it('handles missing total fields from raw query results', async () => {
      projectRepo.count.mockResolvedValueOnce(1);
      projectRepo.count.mockResolvedValueOnce(0);

      const batchQb = makeQueryBuilder();
      batchQb.getRawOne.mockResolvedValue({});
      readingBatchRepo.createQueryBuilder.mockReturnValueOnce(batchQb);

      const retirementQb = makeQueryBuilder();
      retirementQb.getRawOne.mockResolvedValue({});
      retirementRepo.createQueryBuilder.mockReturnValueOnce(retirementQb);

      const result = await service.getOverview();

      expect(result.totalCreditsMinted).toBe(0);
      expect(result.totalCreditsRetired).toBe(0);
    });

    it('builds query builders with the correct aliases and where clauses', async () => {
      projectRepo.count.mockResolvedValueOnce(0);
      projectRepo.count.mockResolvedValueOnce(0);

      const batchQb = makeQueryBuilder();
      batchQb.getRawOne.mockResolvedValue(null);
      readingBatchRepo.createQueryBuilder.mockReturnValueOnce(batchQb);

      const retirementQb = makeQueryBuilder();
      retirementQb.getRawOne.mockResolvedValue(null);
      retirementRepo.createQueryBuilder.mockReturnValueOnce(retirementQb);

      await service.getOverview();

      expect(readingBatchRepo.createQueryBuilder).toHaveBeenCalledWith('batch');
      expect(batchQb.select).toHaveBeenCalledWith('SUM(batch.creditsGenerated)', 'total');
      expect(batchQb.where).toHaveBeenCalledWith('batch.status = :status', {
        status: BatchStatus.CONFIRMED,
      });

      expect(retirementRepo.createQueryBuilder).toHaveBeenCalledWith('retirement');
      expect(retirementQb.select).toHaveBeenCalledWith('SUM(retirement.amount)', 'total');
    });
  });

  // ── getCreditsOverTime ────────────────────────────────────────────────────

  describe('getCreditsOverTime', () => {
    it('returns minted and retired time series for the last 6 months', async () => {
      const mintedRows = [
        { month: '2026-01-01', amount: '10000' },
        { month: '2026-02-01', amount: '20000' },
      ];
      const retiredRows = [
        { month: '2026-01-01', amount: '5000' },
        { month: '2026-03-01', amount: '7500.25' },
      ];

      const batchQb = makeQueryBuilder();
      batchQb.getRawMany.mockResolvedValue(mintedRows);
      readingBatchRepo.createQueryBuilder.mockReturnValueOnce(batchQb);

      const retirementQb = makeQueryBuilder();
      retirementQb.getRawMany.mockResolvedValue(retiredRows);
      retirementRepo.createQueryBuilder.mockReturnValueOnce(retirementQb);

      const result = await service.getCreditsOverTime();

      expect(result).toEqual({
        minted: [
          { month: '2026-01-01', amount: 10000 },
          { month: '2026-02-01', amount: 20000 },
        ],
        retired: [
          { month: '2026-01-01', amount: 5000 },
          { month: '2026-03-01', amount: 7500.25 },
        ],
      });
    });

    it('returns empty arrays when no data exists', async () => {
      const batchQb = makeQueryBuilder();
      batchQb.getRawMany.mockResolvedValue([]);
      readingBatchRepo.createQueryBuilder.mockReturnValueOnce(batchQb);

      const retirementQb = makeQueryBuilder();
      retirementQb.getRawMany.mockResolvedValue([]);
      retirementRepo.createQueryBuilder.mockReturnValueOnce(retirementQb);

      const result = await service.getCreditsOverTime();

      expect(result).toEqual({ minted: [], retired: [] });
    });

    it('filters by confirmed status and date range with correct query builder methods', async () => {
      const batchQb = makeQueryBuilder();
      batchQb.getRawMany.mockResolvedValue([]);
      readingBatchRepo.createQueryBuilder.mockReturnValueOnce(batchQb);

      const retirementQb = makeQueryBuilder();
      retirementQb.getRawMany.mockResolvedValue([]);
      retirementRepo.createQueryBuilder.mockReturnValueOnce(retirementQb);

      await service.getCreditsOverTime();

      expect(readingBatchRepo.createQueryBuilder).toHaveBeenCalledWith('batch');
      expect(batchQb.select).toHaveBeenCalledWith(
        "DATE_TRUNC('month', batch.confirmed_at)",
        'month',
      );
      expect(batchQb.addSelect).toHaveBeenCalledWith('SUM(batch.credits_generated)', 'amount');
      expect(batchQb.where).toHaveBeenCalledWith('batch.status = :status', {
        status: BatchStatus.CONFIRMED,
      });
      expect(batchQb.andWhere).toHaveBeenCalledWith('batch.confirmed_at >= :date', {
        date: expect.any(Date),
      });
      expect(batchQb.groupBy).toHaveBeenCalledWith('month');
      expect(batchQb.orderBy).toHaveBeenCalledWith('month', 'ASC');

      expect(retirementRepo.createQueryBuilder).toHaveBeenCalledWith('retirement');
      expect(retirementQb.select).toHaveBeenCalledWith(
        "DATE_TRUNC('month', retirement.retired_at)",
        'month',
      );
      expect(retirementQb.addSelect).toHaveBeenCalledWith('SUM(retirement.amount)', 'amount');
      expect(retirementQb.where).toHaveBeenCalledWith('retirement.retired_at >= :date', {
        date: expect.any(Date),
      });
    });
  });

  // ── getProjectDistribution ────────────────────────────────────────────────

  describe('getProjectDistribution', () => {
    it('returns distribution by status and by methodology', async () => {
      const statusRows = [
        { status: 'draft', count: '5' },
        { status: 'active', count: '12' },
        { status: 'completed', count: '3' },
      ];
      const methodologyRows = [
        { methodology: 'VM0036', count: '8' },
        { methodology: 'VM0042', count: '7' },
        { methodology: 'VM0007', count: '5' },
      ];

      const statusQb = makeQueryBuilder();
      statusQb.getRawMany.mockResolvedValue(statusRows);
      const methodologyQb = makeQueryBuilder();
      methodologyQb.getRawMany.mockResolvedValue(methodologyRows);

      projectRepo.createQueryBuilder
        .mockReturnValueOnce(statusQb)
        .mockReturnValueOnce(methodologyQb);

      const result = await service.getProjectDistribution();

      expect(result).toEqual({
        byStatus: [
          { status: 'draft', count: 5 },
          { status: 'active', count: 12 },
          { status: 'completed', count: 3 },
        ],
        byMethodology: [
          { methodology: 'VM0036', count: 8 },
          { methodology: 'VM0042', count: 7 },
          { methodology: 'VM0007', count: 5 },
        ],
      });
    });

    it('returns empty arrays when no projects exist', async () => {
      const statusQb = makeQueryBuilder();
      statusQb.getRawMany.mockResolvedValue([]);
      const methodologyQb = makeQueryBuilder();
      methodologyQb.getRawMany.mockResolvedValue([]);

      projectRepo.createQueryBuilder
        .mockReturnValueOnce(statusQb)
        .mockReturnValueOnce(methodologyQb);

      const result = await service.getProjectDistribution();

      expect(result).toEqual({ byStatus: [], byMethodology: [] });
    });

    it('parses count strings to integers', async () => {
      const statusQb = makeQueryBuilder();
      statusQb.getRawMany.mockResolvedValue([{ status: 'active', count: '99' }]);
      const methodologyQb = makeQueryBuilder();
      methodologyQb.getRawMany.mockResolvedValue([]);

      projectRepo.createQueryBuilder
        .mockReturnValueOnce(statusQb)
        .mockReturnValueOnce(methodologyQb);

      const result = await service.getProjectDistribution();

      expect(result.byStatus[0].count).toBe(99);
    });

    it('builds correct query builder chains', async () => {
      const statusQb = makeQueryBuilder();
      statusQb.getRawMany.mockResolvedValue([]);
      const methodologyQb = makeQueryBuilder();
      methodologyQb.getRawMany.mockResolvedValue([]);

      projectRepo.createQueryBuilder
        .mockReturnValueOnce(statusQb)
        .mockReturnValueOnce(methodologyQb);

      await service.getProjectDistribution();

      expect(projectRepo.createQueryBuilder).toHaveBeenCalledWith('project');
      expect(statusQb.select).toHaveBeenCalledWith('project.status', 'status');
      expect(statusQb.addSelect).toHaveBeenCalledWith('COUNT(*)', 'count');
      expect(statusQb.groupBy).toHaveBeenCalledWith('project.status');

      expect(methodologyQb.select).toHaveBeenCalledWith('project.methodology', 'methodology');
      expect(methodologyQb.addSelect).toHaveBeenCalledWith('COUNT(*)', 'count');
      expect(methodologyQb.groupBy).toHaveBeenCalledWith('project.methodology');
    });
  });

  // ── getRetirementByPurpose ────────────────────────────────────────────────

  describe('getRetirementByPurpose', () => {
    it('returns aggregated amounts grouped by purpose', async () => {
      const rows = [
        { purpose: 'compliance', amount: '100000' },
        { purpose: 'voluntary', amount: '50000' },
        { purpose: 'carbon_offset', amount: '25000.75' },
      ];

      const qb = makeQueryBuilder();
      qb.getRawMany.mockResolvedValue(rows);
      retirementRepo.createQueryBuilder.mockReturnValueOnce(qb);

      const result = await service.getRetirementByPurpose();

      expect(result).toEqual([
        { purpose: 'compliance', amount: 100000 },
        { purpose: 'voluntary', amount: 50000 },
        { purpose: 'carbon_offset', amount: 25000.75 },
      ]);
    });

    it('returns empty array when no retirements exist', async () => {
      const qb = makeQueryBuilder();
      qb.getRawMany.mockResolvedValue([]);
      retirementRepo.createQueryBuilder.mockReturnValueOnce(qb);

      const result = await service.getRetirementByPurpose();

      expect(result).toEqual([]);
    });

    it('builds correct query builder chain', async () => {
      const qb = makeQueryBuilder();
      qb.getRawMany.mockResolvedValue([]);
      retirementRepo.createQueryBuilder.mockReturnValueOnce(qb);

      await service.getRetirementByPurpose();

      expect(retirementRepo.createQueryBuilder).toHaveBeenCalledWith('retirement');
      expect(qb.select).toHaveBeenCalledWith('retirement.purpose', 'purpose');
      expect(qb.addSelect).toHaveBeenCalledWith('SUM(retirement.amount)', 'amount');
      expect(qb.groupBy).toHaveBeenCalledWith('retirement.purpose');
    });

    it('parses amount strings to floats', async () => {
      const qb = makeQueryBuilder();
      qb.getRawMany.mockResolvedValue([{ purpose: 'compliance', amount: '12345.678900' }]);
      retirementRepo.createQueryBuilder.mockReturnValueOnce(qb);

      const result = await service.getRetirementByPurpose();

      expect(result[0].amount).toBeCloseTo(12345.6789);
    });
  });

  // ── getTopProjects ────────────────────────────────────────────────────────

  describe('getTopProjects', () => {
    it('returns top projects with default limit of 5', async () => {
      const rows = [
        { id: 'proj-1', name: 'Green Valley', totalGenerated: '80000' },
        { id: 'proj-2', name: 'Blue River', totalGenerated: '60000' },
        { id: 'proj-3', name: 'Sunrise Forest', totalGenerated: '40000' },
      ];

      const qb = makeQueryBuilder();
      qb.getRawMany.mockResolvedValue(rows);
      readingBatchRepo.createQueryBuilder.mockReturnValueOnce(qb);

      const result = await service.getTopProjects();

      expect(result).toEqual([
        { id: 'proj-1', name: 'Green Valley', totalGenerated: 80000 },
        { id: 'proj-2', name: 'Blue River', totalGenerated: 60000 },
        { id: 'proj-3', name: 'Sunrise Forest', totalGenerated: 40000 },
      ]);

      expect(qb.limit).toHaveBeenCalledWith(5);
    });

    it('accepts a custom limit parameter', async () => {
      const rows = [{ id: 'proj-1', name: 'Green Valley', totalGenerated: '80000' }];

      const qb = makeQueryBuilder();
      qb.getRawMany.mockResolvedValue(rows);
      readingBatchRepo.createQueryBuilder.mockReturnValueOnce(qb);

      await service.getTopProjects(1);

      expect(qb.limit).toHaveBeenCalledWith(1);
    });

    it('returns empty array when no confirmed batches exist', async () => {
      const qb = makeQueryBuilder();
      qb.getRawMany.mockResolvedValue([]);
      readingBatchRepo.createQueryBuilder.mockReturnValueOnce(qb);

      const result = await service.getTopProjects();

      expect(result).toEqual([]);
    });

    it('builds correct query builder chain with innerJoin', async () => {
      const qb = makeQueryBuilder();
      qb.getRawMany.mockResolvedValue([]);
      readingBatchRepo.createQueryBuilder.mockReturnValueOnce(qb);

      await service.getTopProjects();

      expect(readingBatchRepo.createQueryBuilder).toHaveBeenCalledWith('batch');
      expect(qb.innerJoin).toHaveBeenCalledWith('batch.project', 'project');
      expect(qb.select).toHaveBeenCalledWith('project.id', 'id');
      expect(qb.addSelect).toHaveBeenCalledWith('project.name', 'name');
      expect(qb.addSelect).toHaveBeenCalledWith('SUM(batch.credits_generated)', 'totalGenerated');
      expect(qb.where).toHaveBeenCalledWith('batch.status = :status', {
        status: BatchStatus.CONFIRMED,
      });
      expect(qb.groupBy).toHaveBeenCalledWith('project.id');
      expect(qb.addGroupBy).toHaveBeenCalledWith('project.name');
      expect(qb.orderBy).toHaveBeenCalledWith('"totalGenerated"', 'DESC');
      expect(qb.limit).toHaveBeenCalledWith(5);
    });

    it('parses totalGenerated strings to floats', async () => {
      const qb = makeQueryBuilder();
      qb.getRawMany.mockResolvedValue([{ id: 'proj-1', name: 'Test', totalGenerated: '99.999' }]);
      readingBatchRepo.createQueryBuilder.mockReturnValueOnce(qb);

      const result = await service.getTopProjects(1);

      expect(result[0].totalGenerated).toBeCloseTo(99.999);
    });
  });

  // ── getTopRetirees ────────────────────────────────────────────────────────

  describe('getTopRetirees', () => {
    it('returns top retirees with default limit of 5', async () => {
      const rows = [
        { id: 'user-1', name: 'Alice', totalRetired: '50000' },
        { id: 'user-2', name: 'Bob', totalRetired: '30000' },
        { id: 'user-3', name: 'Charlie', totalRetired: '10000' },
      ];

      const qb = makeQueryBuilder();
      qb.getRawMany.mockResolvedValue(rows);
      retirementRepo.createQueryBuilder.mockReturnValueOnce(qb);

      const result = await service.getTopRetirees();

      expect(result).toEqual([
        { id: 'user-1', name: 'Alice', totalRetired: 50000 },
        { id: 'user-2', name: 'Bob', totalRetired: 30000 },
        { id: 'user-3', name: 'Charlie', totalRetired: 10000 },
      ]);

      expect(qb.limit).toHaveBeenCalledWith(5);
    });

    it('accepts a custom limit parameter', async () => {
      const qb = makeQueryBuilder();
      qb.getRawMany.mockResolvedValue([]);
      retirementRepo.createQueryBuilder.mockReturnValueOnce(qb);

      await service.getTopRetirees(10);

      expect(qb.limit).toHaveBeenCalledWith(10);
    });

    it('returns empty array when no retirements exist', async () => {
      const qb = makeQueryBuilder();
      qb.getRawMany.mockResolvedValue([]);
      retirementRepo.createQueryBuilder.mockReturnValueOnce(qb);

      const result = await service.getTopRetirees();

      expect(result).toEqual([]);
    });

    it('builds correct query builder chain with innerJoin', async () => {
      const qb = makeQueryBuilder();
      qb.getRawMany.mockResolvedValue([]);
      retirementRepo.createQueryBuilder.mockReturnValueOnce(qb);

      await service.getTopRetirees();

      expect(retirementRepo.createQueryBuilder).toHaveBeenCalledWith('retirement');
      expect(qb.innerJoin).toHaveBeenCalledWith('retirement.user', 'user');
      expect(qb.select).toHaveBeenCalledWith('user.id', 'id');
      expect(qb.addSelect).toHaveBeenCalledWith('user.displayName', 'name');
      expect(qb.addSelect).toHaveBeenCalledWith('SUM(retirement.amount)', 'totalRetired');
      expect(qb.groupBy).toHaveBeenCalledWith('user.id');
      expect(qb.addGroupBy).toHaveBeenCalledWith('user.displayName');
      expect(qb.orderBy).toHaveBeenCalledWith('"totalRetired"', 'DESC');
      expect(qb.limit).toHaveBeenCalledWith(5);
    });

    it('handles null displayName gracefully', async () => {
      const qb = makeQueryBuilder();
      qb.getRawMany.mockResolvedValue([{ id: 'user-1', name: null, totalRetired: '1000' }]);
      retirementRepo.createQueryBuilder.mockReturnValueOnce(qb);

      const result = await service.getTopRetirees(1);

      expect(result[0].name).toBeNull();
      expect(result[0].totalRetired).toBe(1000);
    });

    it('parses totalRetired strings to floats', async () => {
      const qb = makeQueryBuilder();
      qb.getRawMany.mockResolvedValue([{ id: 'user-1', name: 'Alice', totalRetired: '777.77' }]);
      retirementRepo.createQueryBuilder.mockReturnValueOnce(qb);

      const result = await service.getTopRetirees(1);

      expect(result[0].totalRetired).toBeCloseTo(777.77);
    });
  });
});
