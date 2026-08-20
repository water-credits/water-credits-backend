import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Project, ProjectStatus } from '../projects/entities/project.entity';
import { Retirement } from '../credits/entities/retirement.entity';
import { ReadingBatch, BatchStatus } from '../sensors/entities/reading-batch.entity';
import { User } from '../users/entities/user.entity';

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

@Injectable()
export class AnalyticsService {
  private readonly logger = new Logger(AnalyticsService.name);
  private readonly cache = new Map<string, CacheEntry<unknown>>();
  private readonly cacheTtlMs: number;

  constructor(
    @InjectRepository(Project)
    private projectRepository: Repository<Project>,
    @InjectRepository(Retirement)
    private retirementRepository: Repository<Retirement>,
    @InjectRepository(ReadingBatch)
    private readingBatchRepository: Repository<ReadingBatch>,
    @InjectRepository(User)
    private userRepository: Repository<User>,
  ) {
    // TTL in seconds from env, default 60s; 0 disables caching.
    this.cacheTtlMs = (parseInt(process.env.ANALYTICS_CACHE_TTL_S || '60', 10) || 0) * 1000;
  }

  private getFromCache<T>(key: string): T | null {
    if (this.cacheTtlMs <= 0) return null;
    const entry = this.cache.get(key) as CacheEntry<T> | undefined;
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return null;
    }
    return entry.data;
  }

  private setCache(key: string, data: unknown): void {
    if (this.cacheTtlMs <= 0) return;
    this.cache.set(key, { data, expiresAt: Date.now() + this.cacheTtlMs });
  }

  clearCache(): void {
    this.cache.clear();
  }

  async getOverview() {
    const cacheKey = 'analytics:overview';
    const cached = this.getFromCache<{
      totalProjects: number;
      activeProjects: number;
      totalCreditsMinted: number;
      totalCreditsRetired: number;
    }>(cacheKey);
    if (cached) return cached;

    const totalProjects = await this.projectRepository.count();
    const activeProjects = await this.projectRepository.count({
      where: { status: ProjectStatus.ACTIVE },
    });

    const creditsMintedResult = await this.readingBatchRepository
      .createQueryBuilder('batch')
      .select('SUM(batch.creditsGenerated)', 'total')
      .where('batch.status = :status', { status: BatchStatus.CONFIRMED })
      .getRawOne();

    const creditsRetiredResult = await this.retirementRepository
      .createQueryBuilder('retirement')
      .select('SUM(retirement.amount)', 'total')
      .getRawOne();

    const result = {
      totalProjects,
      activeProjects,
      totalCreditsMinted: parseFloat(creditsMintedResult?.total || '0'),
      totalCreditsRetired: parseFloat(creditsRetiredResult?.total || '0'),
    };

    this.setCache(cacheKey, result);
    return result;
  }

  async getCreditsOverTime() {
    const cacheKey = 'analytics:credits-over-time';
    const cached = this.getFromCache<{
      minted: Array<{ month: string; amount: number }>;
      retired: Array<{ month: string; amount: number }>;
    }>(cacheKey);
    if (cached) return cached;

    const last6Months = new Date();
    last6Months.setMonth(last6Months.getMonth() - 6);

    const minted = await this.readingBatchRepository
      .createQueryBuilder('batch')
      .select("DATE_TRUNC('month', batch.confirmed_at)", 'month')
      .addSelect('SUM(batch.credits_generated)', 'amount')
      .where('batch.status = :status', { status: BatchStatus.CONFIRMED })
      .andWhere('batch.confirmed_at >= :date', { date: last6Months })
      .groupBy('month')
      .orderBy('month', 'ASC')
      .getRawMany();

    const retired = await this.retirementRepository
      .createQueryBuilder('retirement')
      .select("DATE_TRUNC('month', retirement.retired_at)", 'month')
      .addSelect('SUM(retirement.amount)', 'amount')
      .where('retirement.retired_at >= :date', { date: last6Months })
      .groupBy('month')
      .orderBy('month', 'ASC')
      .getRawMany();

    const result = {
      minted: minted.map((m) => ({ month: m.month, amount: parseFloat(m.amount) })),
      retired: retired.map((r) => ({ month: r.month, amount: parseFloat(r.amount) })),
    };

    this.setCache(cacheKey, result);
    return result;
  }

  async getProjectDistribution() {
    const cacheKey = 'analytics:project-distribution';
    const cached = this.getFromCache<{
      byStatus: Array<{ status: string; count: number }>;
      byMethodology: Array<{ methodology: string; count: number }>;
    }>(cacheKey);
    if (cached) return cached;

    const byStatus = await this.projectRepository
      .createQueryBuilder('project')
      .select('project.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .groupBy('project.status')
      .getRawMany();

    const byMethodology = await this.projectRepository
      .createQueryBuilder('project')
      .select('project.methodology', 'methodology')
      .addSelect('COUNT(*)', 'count')
      .groupBy('project.methodology')
      .getRawMany();

    const result = {
      byStatus: byStatus.map((s) => ({ status: s.status, count: parseInt(s.count) })),
      byMethodology: byMethodology.map((m) => ({
        methodology: m.methodology,
        count: parseInt(m.count),
      })),
    };

    this.setCache(cacheKey, result);
    return result;
  }

  async getRetirementByPurpose() {
    const cacheKey = 'analytics:retirement-by-purpose';
    const cached = this.getFromCache<Array<{ purpose: string; amount: number }>>(cacheKey);
    if (cached) return cached;

    const result = await this.retirementRepository
      .createQueryBuilder('retirement')
      .select('retirement.purpose', 'purpose')
      .addSelect('SUM(retirement.amount)', 'amount')
      .groupBy('retirement.purpose')
      .getRawMany();

    const mapped = result.map((r) => ({
      purpose: r.purpose,
      amount: parseFloat(r.amount),
    }));

    this.setCache(cacheKey, mapped);
    return mapped;
  }

  async getTopProjects(limit: number = 5) {
    const cacheKey = `analytics:top-projects:${limit}`;
    const cached = this.getFromCache<Array<{ id: string; name: string; totalGenerated: number }>>(
      cacheKey,
    );
    if (cached) return cached;

    const result = await this.readingBatchRepository
      .createQueryBuilder('batch')
      .innerJoin('batch.project', 'project')
      .select('project.id', 'id')
      .addSelect('project.name', 'name')
      .addSelect('SUM(batch.credits_generated)', 'totalGenerated')
      .where('batch.status = :status', { status: BatchStatus.CONFIRMED })
      .groupBy('project.id')
      .addGroupBy('project.name')
      .orderBy('"totalGenerated"', 'DESC')
      .limit(limit)
      .getRawMany();

    const mapped = result.map((r) => ({
      id: r.id,
      name: r.name,
      totalGenerated: parseFloat(r.totalGenerated),
    }));

    this.setCache(cacheKey, mapped);
    return mapped;
  }

  async getTopRetirees(limit: number = 5) {
    const cacheKey = `analytics:top-retirees:${limit}`;
    const cached = this.getFromCache<Array<{ id: string; name: string; totalRetired: number }>>(
      cacheKey,
    );
    if (cached) return cached;

    const result = await this.retirementRepository
      .createQueryBuilder('retirement')
      .innerJoin('retirement.user', 'user')
      .select('user.id', 'id')
      .addSelect('user.displayName', 'name')
      .addSelect('SUM(retirement.amount)', 'totalRetired')
      .groupBy('user.id')
      .addGroupBy('user.displayName')
      .orderBy('"totalRetired"', 'DESC')
      .limit(limit)
      .getRawMany();

    const mapped = result.map((r) => ({
      id: r.id,
      name: r.name,
      totalRetired: parseFloat(r.totalRetired),
    }));

    this.setCache(cacheKey, mapped);
    return mapped;
  }
}
