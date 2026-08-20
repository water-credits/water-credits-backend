import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { Repository, Not, IsNull } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { Retirement } from './entities/retirement.entity';
import { RetireCreditsDto } from './dto/retire-credits.dto';
import { CreditQueryDto } from './dto/credit-query.dto';
import { Project, ProjectStatus } from '../projects/entities/project.entity';
import { User } from '../users/entities/user.entity';
import { StellarService } from '../stellar/stellar.service';

// Shape of the response for GET /credits
export interface CreditOverview {
  totalMinted: number | null;
  totalRetired: number;
  activeProjects: number;
  topRetirers: Array<{ id: string; name: string | null; totalRetired: number }>;
  onChainData: { totalMinted: number; totalRetired: number } | null;
  stale: boolean;
}

// Shape of the response for GET /credits/projects/:projectId
export interface ProjectCreditDetail {
  projectId: string;
  creditTokenAddress: string | null;
  onChainBalance: number | null;
  totalMinted: number | null;
  totalRetired: number;
  retirements: Retirement[];
  onChainData: {
    balance: number | null;
    totalMinted: number;
    totalRetired: number;
  } | null;
  stale: boolean;
}

@Injectable()
export class CreditsService {
  private readonly logger = new Logger(CreditsService.name);

  constructor(
    @InjectRepository(Retirement)
    private readonly retirementRepo: Repository<Retirement>,
    @InjectRepository(Project)
    private readonly projectRepo: Repository<Project>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @InjectQueue('retirements')
    private readonly retirementsQueue: Queue,
    private readonly configService: ConfigService,
    private readonly stellarService: StellarService,
  ) {}

  async getPortfolio(userId: string): Promise<{
    totalRetired: number;
    totalValue: number;
    projects: Array<{
      projectId: string;
      projectName: string;
      retired: number;
      certificateCount: number;
    }>;
  }> {
    const retirements = await this.retirementRepo.find({
      where: { userId },
      relations: ['project'],
      order: { retiredAt: 'DESC' },
    });

    const projectMap = new Map<
      string,
      {
        projectId: string;
        projectName: string;
        retired: number;
        certificateCount: number;
      }
    >();

    let totalRetired = 0;

    for (const r of retirements) {
      totalRetired += Number(r.amount);
      const entry = projectMap.get(r.projectId) || {
        projectId: r.projectId,
        projectName: r.project?.name ?? 'Unknown',
        retired: 0,
        certificateCount: 0,
      };
      entry.retired += Number(r.amount);
      entry.certificateCount++;
      projectMap.set(r.projectId, entry);
    }

    const creditPrice = this.configService.get<number>('CREDIT_PRICE_PER_UNIT') ?? 1;
    const totalValue = totalRetired * creditPrice;

    return {
      totalRetired,
      totalValue,
      projects: Array.from(projectMap.values()),
    };
  }

  async retire(userId: string, dto: RetireCreditsDto): Promise<Retirement> {
    if (dto.amount <= 0) {
      throw new BadRequestException('Amount must be positive');
    }

    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user || !user.wallet) {
      throw new BadRequestException('User wallet not found');
    }

    // The retirement job calls the Soroban contract directly by address, so
    // a project without a deployed credit token would enqueue a job that is
    // guaranteed to fail on-chain. Fail fast instead of burning retries.
    const project = await this.projectRepo.findOne({ where: { id: dto.projectId } });
    if (!project?.creditTokenAddress) {
      throw new BadRequestException('Project credit token not yet deployed');
    }
    const tokenId = project.creditTokenAddress;

    // Verify caller holds sufficient on-chain token balance before creating DB record or queuing
    const balance = await this.stellarService.getBalance(tokenId, user.wallet);
    if (balance.isLessThan(dto.amount)) {
      throw new BadRequestException(
        `Insufficient credit balance. Required: ${dto.amount}, Available: ${balance.toString()}`,
      );
    }

    const retirement = this.retirementRepo.create({
      userId,
      projectId: dto.projectId,
      amount: dto.amount,
      purpose: dto.purpose,
      metadataUri: dto.metadataUri ?? null,
      txHash: '',
      retiredAt: new Date(),
    });

    const saved = await this.retirementRepo.save(retirement);

    await this.retirementsQueue.add(
      'process-retirement',
      {
        retirementId: saved.id,
        userId,
        projectId: dto.projectId,
        tokenId,
        amount: dto.amount,
        purpose: dto.purpose,
      },
      {
        attempts: 5,
        backoff: { type: 'fixed', delay: 30000 },
        removeOnComplete: 100,
      },
    );

    this.logger.log(`Queued retirement ${saved.id} for user ${userId}`);
    return saved;
  }

  async getRetirements(
    userId: string,
    query: CreditQueryDto,
  ): Promise<{ data: Retirement[]; total: number; page: number; limit: number }> {
    const qb = this.retirementRepo
      .createQueryBuilder('retirement')
      .leftJoinAndSelect('retirement.project', 'project')
      .where('retirement.user_id = :userId', { userId });

    if (query.projectId) {
      qb.andWhere('retirement.project_id = :projectId', { projectId: query.projectId });
    }
    if (query.startDate) {
      qb.andWhere('retirement.retired_at >= :startDate', { startDate: query.startDate });
    }
    if (query.endDate) {
      qb.andWhere('retirement.retired_at <= :endDate', { endDate: query.endDate });
    }

    qb.orderBy('retirement.retired_at', 'DESC');
    qb.skip(query.skip).take(query.limit);

    const [data, total] = await qb.getManyAndCount();
    return { data, total, page: query.page ?? 1, limit: query.limit ?? 20 };
  }

  async getCertificate(id: string, userId: string): Promise<Retirement> {
    const retirement = await this.retirementRepo.findOne({
      where: { id, userId },
      relations: ['project'],
    });
    if (!retirement) {
      throw new NotFoundException('Retirement not found');
    }
    return retirement;
  }

  async findByProject(projectId: string): Promise<Retirement[]> {
    return this.retirementRepo.find({
      where: { projectId },
      order: { retiredAt: 'DESC' },
    });
  }

  async getTotalRetired(): Promise<number> {
    const result = await this.retirementRepo
      .createQueryBuilder('retirement')
      .select('COALESCE(SUM(retirement.amount), 0)', 'total')
      .getRawOne();
    return result ? parseFloat(result.total) : 0;
  }

  // ── Global credit overview (GET /credits) ──────────────────────────────
  //
  // DB-sourced values (retirements sum, active project count, top retirers)
  // are always returned.  When the Soroban RPC is reachable we additionally
  // surface the on-chain total_supply / total_retired; on any RPC failure we
  // degrade gracefully: HTTP 200 with onChainData: null and stale: true.

  async getCreditOverview(): Promise<CreditOverview> {
    const [dbTotalRetired, activeProjects, topRetirers, tokenProjects] = await Promise.all([
      this.getTotalRetired(),
      this.projectRepo.count({ where: { status: ProjectStatus.ACTIVE } }),
      this.getTopRetirers(5),
      this.projectRepo.find({
        where: { creditTokenAddress: Not(IsNull()) },
        select: { id: true, creditTokenAddress: true },
      }),
    ]);

    const overview: CreditOverview = {
      totalMinted: null,
      totalRetired: dbTotalRetired,
      activeProjects,
      topRetirers,
      onChainData: null,
      stale: false,
    };

    const tokenAddresses = tokenProjects
      .map((p) => p.creditTokenAddress)
      .filter((a): a is string => !!a);

    if (tokenAddresses.length === 0) {
      return overview;
    }

    try {
      let totalMinted = 0;
      let totalRetired = 0;
      for (const tokenAddress of tokenAddresses) {
        totalMinted += (await this.stellarService.getTotalSupply(tokenAddress)).toNumber();
        totalRetired += (await this.stellarService.getTotalRetired(tokenAddress)).toNumber();
      }
      overview.onChainData = { totalMinted, totalRetired };
      overview.totalMinted = totalMinted;
      overview.totalRetired = totalRetired;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Stellar RPC unavailable for credit overview, returning stale DB data: ${message}`,
      );
      overview.onChainData = null;
      overview.stale = true;
    }

    return overview;
  }

  // ── Per-project credit detail (GET /credits/projects/:projectId) ───────
  //
  // Joins the project's creditTokenAddress with on-chain reads (balance of
  // the project owner's wallet, total_supply, total_retired) and the local
  // retirements table.  Projects without a deployed token (DRAFT/REGISTERED)
  // skip the RPC entirely.  RPC failures degrade to DB values with stale: true.

  async getProjectCredits(projectId: string): Promise<ProjectCreditDetail> {
    const project = await this.projectRepo.findOne({
      where: { id: projectId },
      relations: ['owner'],
    });
    if (!project) {
      throw new NotFoundException('Project not found');
    }

    const retirements = await this.findByProject(projectId);
    const dbTotalRetired = retirements.reduce((sum, r) => sum + Number(r.amount), 0);

    const detail: ProjectCreditDetail = {
      projectId: project.id,
      creditTokenAddress: project.creditTokenAddress,
      onChainBalance: null,
      totalMinted: null,
      totalRetired: dbTotalRetired,
      retirements,
      onChainData: null,
      stale: false,
    };

    // No deployed token (e.g. DRAFT/REGISTERED) — nothing to read on-chain.
    if (!project.creditTokenAddress) {
      return detail;
    }

    try {
      const balance = project.owner?.wallet
        ? (
            await this.stellarService.getBalance(project.creditTokenAddress, project.owner.wallet)
          ).toNumber()
        : null;
      const totalMinted = (
        await this.stellarService.getTotalSupply(project.creditTokenAddress)
      ).toNumber();
      const totalRetired = (
        await this.stellarService.getTotalRetired(project.creditTokenAddress)
      ).toNumber();

      detail.onChainData = { balance, totalMinted, totalRetired };
      detail.onChainBalance = balance;
      detail.totalMinted = totalMinted;
      detail.totalRetired = totalRetired;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Stellar RPC unavailable for project ${projectId}, returning stale DB data: ${message}`,
      );
      detail.onChainData = null;
      detail.stale = true;
    }

    return detail;
  }

  private async getTopRetirers(limit = 5): Promise<CreditOverview['topRetirers']> {
    const result = await this.retirementRepo
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

    return result.map((r) => ({
      id: r.id,
      name: r.name ?? null,
      totalRetired: parseFloat(r.totalRetired),
    }));
  }
}
