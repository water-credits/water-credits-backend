import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { getQueueToken } from '@nestjs/bull';
import { ConfigService } from '@nestjs/config';
import { BigNumber } from 'bignumber.js';
import { CreditsService } from './credits.service';
import { Retirement } from './entities/retirement.entity';
import { RetireCreditsDto } from './dto/retire-credits.dto';
import { Project } from '../projects/entities/project.entity';
import { User } from '../users/entities/user.entity';
import { StellarService } from '../stellar/stellar.service';

// ── Typed mock factories ──────────────────────────────────────────────────────

type RetirementRepoMock = {
  find: jest.Mock;
  findOne: jest.Mock;
  create: jest.Mock;
  save: jest.Mock;
  createQueryBuilder: jest.Mock;
};

function makeRetirementRepo(): RetirementRepoMock {
  return {
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
    create: jest.fn(),
    save: jest.fn(),
    createQueryBuilder: jest.fn(() => ({
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
      getRawOne: jest.fn().mockResolvedValue({ total: '0' }),
    })),
  };
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('CreditsService', () => {
  let service: CreditsService;
  let retirementRepo: RetirementRepoMock;
  let retirementsQueue: { add: jest.Mock };

  let projectRepo: { find: jest.Mock; findOne: jest.Mock; count: jest.Mock };
  let userRepo: { find: jest.Mock; findOne: jest.Mock };
  let stellarService: {
    getBalance: jest.Mock;
    getTotalSupply: jest.Mock;
    getTotalRetired: jest.Mock;
  };

  beforeEach(async () => {
    retirementRepo = makeRetirementRepo();
    retirementsQueue = { add: jest.fn().mockResolvedValue({ id: 'job-1' }) };
    // Default: project has a deployed token, so retire() proceeds past the
    // tokenId lookup in tests that aren't specifically exercising it.
    projectRepo = {
      find: jest.fn(),
      findOne: jest.fn().mockResolvedValue({ id: 'proj-1', creditTokenAddress: 'C-token-default' }),
      count: jest.fn(),
    };
    userRepo = {
      find: jest.fn(),
      findOne: jest.fn().mockResolvedValue({ id: 'user-1', wallet: 'G-wallet-user-1' }),
    };
    stellarService = {
      getBalance: jest.fn().mockResolvedValue(new BigNumber(1000000)),
      getTotalSupply: jest.fn(),
      getTotalRetired: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CreditsService,
        { provide: getRepositoryToken(Retirement), useValue: retirementRepo },
        { provide: getRepositoryToken(Project), useValue: projectRepo },
        { provide: getRepositoryToken(User), useValue: userRepo },
        { provide: getQueueToken('retirements'), useValue: retirementsQueue },
        { provide: ConfigService, useValue: { get: jest.fn() } },
        {
          provide: StellarService,
          useValue: stellarService,
        },
      ],
    }).compile();

    service = module.get<CreditsService>(CreditsService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  // ── retire — amount validation ───────────────────────────────────────────

  describe('retire — amount validation', () => {
    it('throws BadRequestException when amount is zero', async () => {
      const dto: RetireCreditsDto = {
        projectId: 'proj-1',
        amount: 0,
        purpose: 'compliance',
      };

      await expect(service.retire('user-1', dto)).rejects.toThrow(BadRequestException);
      await expect(service.retire('user-1', dto)).rejects.toThrow('Amount must be positive');
    });

    it('throws BadRequestException when amount is negative', async () => {
      const dto: RetireCreditsDto = {
        projectId: 'proj-1',
        amount: -100,
        purpose: 'compliance',
      };

      await expect(service.retire('user-1', dto)).rejects.toThrow(BadRequestException);
      await expect(service.retire('user-1', dto)).rejects.toThrow('Amount must be positive');
    });

    it('does not throw when amount is a small positive value', async () => {
      const saved: Partial<Retirement> = {
        id: 'ret-uuid-1',
        userId: 'user-1',
        projectId: 'proj-1',
        amount: 0.000001,
        purpose: 'compliance',
        txHash: '',
        retiredAt: new Date(),
      };

      retirementRepo.create.mockReturnValue(saved as Retirement);
      retirementRepo.save.mockResolvedValue(saved as Retirement);

      const dto: RetireCreditsDto = {
        projectId: 'proj-1',
        amount: 0.000001,
        purpose: 'compliance',
      };

      const result = await service.retire('user-1', dto);
      expect(result).toBeDefined();
    });
  });

  // ── retire — queue job payload ────────────────────────────────────────────

  describe('retire — queue job payload', () => {
    it('enqueues a job with the correct shape after saving the retirement record', async () => {
      const saved: Partial<Retirement> = {
        id: 'ret-uuid-42',
        userId: 'user-99',
        projectId: 'proj-abc',
        amount: 5000,
        purpose: 'voluntary',
        metadataUri: 'ipfs://QmTest',
        txHash: '',
        retiredAt: new Date(),
      };

      retirementRepo.create.mockReturnValue(saved as Retirement);
      retirementRepo.save.mockResolvedValue(saved as Retirement);
      projectRepo.findOne.mockResolvedValue({
        id: 'proj-abc',
        creditTokenAddress: 'C-token-abc',
      });

      const dto: RetireCreditsDto = {
        projectId: 'proj-abc',
        amount: 5000,
        purpose: 'voluntary',
        metadataUri: 'ipfs://QmTest',
      };

      await service.retire('user-99', dto);

      expect(retirementsQueue.add).toHaveBeenCalledWith(
        'process-retirement',
        {
          retirementId: 'ret-uuid-42',
          userId: 'user-99',
          projectId: 'proj-abc',
          tokenId: 'C-token-abc',
          amount: 5000,
          purpose: 'voluntary',
        },
        expect.objectContaining({ attempts: 5 }),
      );
    });

    it('returns the saved Retirement record', async () => {
      const saved: Partial<Retirement> = {
        id: 'ret-uuid-1',
        userId: 'user-1',
        projectId: 'proj-1',
        amount: 100,
        purpose: 'compliance',
        txHash: '',
        retiredAt: new Date(),
      };

      retirementRepo.create.mockReturnValue(saved as Retirement);
      retirementRepo.save.mockResolvedValue(saved as Retirement);

      const dto: RetireCreditsDto = {
        projectId: 'proj-1',
        amount: 100,
        purpose: 'compliance',
      };

      const result = await service.retire('user-1', dto);
      expect(result.id).toBe('ret-uuid-1');
    });
  });

  // ── retire — project credit token lookup ──────────────────────────────────

  describe('retire — project credit token lookup', () => {
    it('throws BadRequestException when the project has no creditTokenAddress', async () => {
      projectRepo.findOne.mockResolvedValue({ id: 'proj-1', creditTokenAddress: null });

      const dto: RetireCreditsDto = {
        projectId: 'proj-1',
        amount: 100,
        purpose: 'compliance',
      };

      await expect(service.retire('user-1', dto)).rejects.toThrow(BadRequestException);
      await expect(service.retire('user-1', dto)).rejects.toThrow(
        'Project credit token not yet deployed',
      );
      expect(retirementsQueue.add).not.toHaveBeenCalled();
    });

    it('passes the resolved tokenId through to the queued job', async () => {
      const saved: Partial<Retirement> = {
        id: 'ret-uuid-9',
        userId: 'user-1',
        projectId: 'proj-9',
        amount: 10,
        purpose: 'compliance',
        txHash: '',
        retiredAt: new Date(),
      };
      retirementRepo.create.mockReturnValue(saved as Retirement);
      retirementRepo.save.mockResolvedValue(saved as Retirement);
      projectRepo.findOne.mockResolvedValue({
        id: 'proj-9',
        creditTokenAddress: 'C-token-9',
      });

      const dto: RetireCreditsDto = {
        projectId: 'proj-9',
        amount: 10,
        purpose: 'compliance',
      };

      await service.retire('user-1', dto);

      expect(retirementsQueue.add).toHaveBeenCalledWith(
        'process-retirement',
        expect.objectContaining({ tokenId: 'C-token-9' }),
        expect.any(Object),
      );
    });
  });

  // ── retire — user wallet lookup ──────────────────────────────────────────

  describe('retire — user wallet lookup', () => {
    it('throws BadRequestException when user record is not found', async () => {
      userRepo.findOne.mockResolvedValue(null);

      const dto: RetireCreditsDto = {
        projectId: 'proj-1',
        amount: 100,
        purpose: 'compliance',
      };

      await expect(service.retire('user-nonexistent', dto)).rejects.toThrow(BadRequestException);
      await expect(service.retire('user-nonexistent', dto)).rejects.toThrow(
        'User wallet not found',
      );
      expect(retirementRepo.save).not.toHaveBeenCalled();
      expect(retirementsQueue.add).not.toHaveBeenCalled();
    });

    it('throws BadRequestException when user has no wallet address', async () => {
      userRepo.findOne.mockResolvedValue({ id: 'user-1', wallet: '' });

      const dto: RetireCreditsDto = {
        projectId: 'proj-1',
        amount: 100,
        purpose: 'compliance',
      };

      await expect(service.retire('user-1', dto)).rejects.toThrow(BadRequestException);
      await expect(service.retire('user-1', dto)).rejects.toThrow('User wallet not found');
      expect(retirementRepo.save).not.toHaveBeenCalled();
      expect(retirementsQueue.add).not.toHaveBeenCalled();
    });
  });

  // ── retire — on-chain balance & entitlement validation ────────────────────

  describe('retire — on-chain balance check', () => {
    it('throws BadRequestException when user on-chain balance is less than retirement amount', async () => {
      userRepo.findOne.mockResolvedValue({ id: 'user-1', wallet: 'G-wallet-1' });
      projectRepo.findOne.mockResolvedValue({ id: 'proj-1', creditTokenAddress: 'C-token-1' });
      stellarService.getBalance.mockResolvedValue(new BigNumber(50)); // balance 50, trying to retire 100

      const dto: RetireCreditsDto = {
        projectId: 'proj-1',
        amount: 100,
        purpose: 'compliance',
      };

      await expect(service.retire('user-1', dto)).rejects.toThrow(BadRequestException);
      await expect(service.retire('user-1', dto)).rejects.toThrow(
        'Insufficient credit balance. Required: 100, Available: 50',
      );
      expect(stellarService.getBalance).toHaveBeenCalledWith('C-token-1', 'G-wallet-1');
      // Must not create DB record or queue job
      expect(retirementRepo.save).not.toHaveBeenCalled();
      expect(retirementsQueue.add).not.toHaveBeenCalled();
    });

    it('throws BadRequestException when user has zero on-chain balance', async () => {
      userRepo.findOne.mockResolvedValue({ id: 'user-1', wallet: 'G-wallet-1' });
      projectRepo.findOne.mockResolvedValue({ id: 'proj-1', creditTokenAddress: 'C-token-1' });
      stellarService.getBalance.mockResolvedValue(new BigNumber(0));

      const dto: RetireCreditsDto = {
        projectId: 'proj-1',
        amount: 10,
        purpose: 'offset',
      };

      await expect(service.retire('user-1', dto)).rejects.toThrow(BadRequestException);
      await expect(service.retire('user-1', dto)).rejects.toThrow(
        'Insufficient credit balance. Required: 10, Available: 0',
      );
      expect(retirementRepo.save).not.toHaveBeenCalled();
      expect(retirementsQueue.add).not.toHaveBeenCalled();
    });

    it('proceeds and creates retirement when user has exactly equal balance', async () => {
      userRepo.findOne.mockResolvedValue({ id: 'user-1', wallet: 'G-wallet-1' });
      projectRepo.findOne.mockResolvedValue({ id: 'proj-1', creditTokenAddress: 'C-token-1' });
      stellarService.getBalance.mockResolvedValue(new BigNumber(100));

      const saved: Partial<Retirement> = {
        id: 'ret-exact-1',
        userId: 'user-1',
        projectId: 'proj-1',
        amount: 100,
        purpose: 'exact balance test',
        txHash: '',
        retiredAt: new Date(),
      };
      retirementRepo.create.mockReturnValue(saved as Retirement);
      retirementRepo.save.mockResolvedValue(saved as Retirement);

      const dto: RetireCreditsDto = {
        projectId: 'proj-1',
        amount: 100,
        purpose: 'exact balance test',
      };

      const result = await service.retire('user-1', dto);

      expect(result.id).toBe('ret-exact-1');
      expect(retirementRepo.save).toHaveBeenCalledTimes(1);
      expect(retirementsQueue.add).toHaveBeenCalledTimes(1);
    });

    it('proceeds and creates retirement when user has more than requested balance', async () => {
      userRepo.findOne.mockResolvedValue({ id: 'user-1', wallet: 'G-wallet-1' });
      projectRepo.findOne.mockResolvedValue({ id: 'proj-1', creditTokenAddress: 'C-token-1' });
      stellarService.getBalance.mockResolvedValue(new BigNumber(5000));

      const saved: Partial<Retirement> = {
        id: 'ret-ample-1',
        userId: 'user-1',
        projectId: 'proj-1',
        amount: 100,
        purpose: 'ample balance test',
        txHash: '',
        retiredAt: new Date(),
      };
      retirementRepo.create.mockReturnValue(saved as Retirement);
      retirementRepo.save.mockResolvedValue(saved as Retirement);

      const dto: RetireCreditsDto = {
        projectId: 'proj-1',
        amount: 100,
        purpose: 'ample balance test',
      };

      const result = await service.retire('user-1', dto);

      expect(result.id).toBe('ret-ample-1');
      expect(retirementRepo.save).toHaveBeenCalledTimes(1);
      expect(retirementsQueue.add).toHaveBeenCalledTimes(1);
    });
  });

  // ── retire — partial failure: queue throws after DB save ─────────────────
  //
  // Behaviour contract: if the DB save succeeds but the queue.add() throws,
  // the Retirement record is already persisted.  The service re-throws so the
  // caller is aware of the failure and can retry or alert.  The orphaned DB
  // record is not rolled back here — a separate reconciliation job is
  // responsible for detecting retirements without an associated queue job and
  // re-enqueuing them.

  describe('retire — partial failure (queue throws after DB save)', () => {
    it('re-throws the queue error and the DB record is already saved', async () => {
      const saved: Partial<Retirement> = {
        id: 'ret-orphan-1',
        userId: 'user-1',
        projectId: 'proj-1',
        amount: 500,
        purpose: 'compliance',
        txHash: '',
        retiredAt: new Date(),
      };

      retirementRepo.create.mockReturnValue(saved as Retirement);
      retirementRepo.save.mockResolvedValue(saved as Retirement);

      const queueError = new Error('Redis connection refused');
      retirementsQueue.add.mockRejectedValue(queueError);

      const dto: RetireCreditsDto = {
        projectId: 'proj-1',
        amount: 500,
        purpose: 'compliance',
      };

      // The error from queue.add propagates to the caller.
      await expect(service.retire('user-1', dto)).rejects.toThrow('Redis connection refused');

      // The DB record was saved before the queue call.
      expect(retirementRepo.save).toHaveBeenCalledTimes(1);

      // The queue failed — job was attempted.
      expect(retirementsQueue.add).toHaveBeenCalledTimes(1);
    });

    it('does not call queue.add when retirementRepo.save throws', async () => {
      retirementRepo.create.mockReturnValue({ amount: 500 } as Retirement);
      retirementRepo.save.mockRejectedValue(new Error('DB write error'));

      const dto: RetireCreditsDto = {
        projectId: 'proj-1',
        amount: 500,
        purpose: 'compliance',
      };

      await expect(service.retire('user-1', dto)).rejects.toThrow('DB write error');
      expect(retirementsQueue.add).not.toHaveBeenCalled();
    });
  });

  // ── getCertificate ───────────────────────────────────────────────────────

  describe('getCertificate', () => {
    it('returns the retirement when it belongs to the requesting user', async () => {
      const retirement: Partial<Retirement> = {
        id: 'ret-1',
        userId: 'user-1',
        projectId: 'proj-1',
        amount: 100,
        purpose: 'compliance',
      };
      retirementRepo.findOne.mockResolvedValue(retirement as Retirement);

      const result = await service.getCertificate('ret-1', 'user-1');
      expect(result).toEqual(retirement);
    });

    it('throws NotFoundException when no retirement matches the id/userId pair', async () => {
      retirementRepo.findOne.mockResolvedValue(null);

      await expect(service.getCertificate('ret-not-mine', 'user-1')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // ── getTotalRetired ──────────────────────────────────────────────────────

  describe('getTotalRetired', () => {
    it('returns 0 when there are no retirements', async () => {
      // Override the qb mock for this specific test so getRawOne returns zero.
      const qb = {
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
        getRawOne: jest.fn().mockResolvedValue({ total: '0' }),
      };
      retirementRepo.createQueryBuilder.mockReturnValue(qb);

      const total = await service.getTotalRetired();
      expect(total).toBe(0);
    });

    it('returns the summed retirement amount as a number', async () => {
      const qb = {
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
        getRawOne: jest.fn().mockResolvedValue({ total: '12345.678900' }),
      };
      retirementRepo.createQueryBuilder.mockReturnValue(qb);

      const total = await service.getTotalRetired();
      expect(total).toBeCloseTo(12345.6789);
    });
  });
});

// ── Additional describe block for getPortfolio and getRetirements ─────────

describe('CreditsService — getPortfolio and getRetirements', () => {
  let service: CreditsService;
  let retirementRepo: {
    find: jest.Mock;
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let retirementsQueue: { add: jest.Mock };

  beforeEach(async () => {
    retirementRepo = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn(),
      save: jest.fn(),
      createQueryBuilder: jest.fn(() => ({
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
        getRawOne: jest.fn().mockResolvedValue({ total: '0' }),
      })),
    };
    retirementsQueue = { add: jest.fn().mockResolvedValue({ id: 'job-1' }) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CreditsService,
        { provide: getRepositoryToken(Retirement), useValue: retirementRepo },
        {
          provide: getRepositoryToken(Project),
          useValue: { find: jest.fn(), findOne: jest.fn(), count: jest.fn() },
        },
        {
          provide: getRepositoryToken(User),
          useValue: { find: jest.fn(), findOne: jest.fn() },
        },
        { provide: getQueueToken('retirements'), useValue: retirementsQueue },
        { provide: ConfigService, useValue: { get: jest.fn() } },
        {
          provide: StellarService,
          useValue: {
            getBalance: jest.fn(),
            getTotalSupply: jest.fn(),
            getTotalRetired: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<CreditsService>(CreditsService);
  });

  // ── getPortfolio ────────────────────────────────────────────────────────

  describe('getPortfolio', () => {
    it('returns an empty portfolio when the user has no retirements', async () => {
      retirementRepo.find.mockResolvedValue([]);

      const result = await service.getPortfolio('user-1');

      expect(result.totalRetired).toBe(0);
      expect(result.projects).toHaveLength(0);
    });

    it('aggregates retirements by project correctly', async () => {
      const retirements: Partial<Retirement>[] = [
        {
          id: 'r-1',
          userId: 'user-1',
          projectId: 'proj-a',
          amount: 100,
          project: { name: 'Green Valley' } as never,
        },
        {
          id: 'r-2',
          userId: 'user-1',
          projectId: 'proj-a',
          amount: 200,
          project: { name: 'Green Valley' } as never,
        },
        {
          id: 'r-3',
          userId: 'user-1',
          projectId: 'proj-b',
          amount: 50,
          project: { name: 'Blue River' } as never,
        },
      ];
      retirementRepo.find.mockResolvedValue(retirements as Retirement[]);

      const result = await service.getPortfolio('user-1');

      expect(result.totalRetired).toBe(350);
      expect(result.projects).toHaveLength(2);

      const projA = result.projects.find((p) => p.projectId === 'proj-a');
      expect(projA).toBeDefined();
      expect(projA!.retired).toBe(300);
      expect(projA!.certificateCount).toBe(2);
      expect(projA!.projectName).toBe('Green Valley');

      const projB = result.projects.find((p) => p.projectId === 'proj-b');
      expect(projB!.retired).toBe(50);
    });

    it('uses "Unknown" as projectName when project relation is null', async () => {
      const retirements: Partial<Retirement>[] = [
        { id: 'r-1', userId: 'user-1', projectId: 'proj-x', amount: 10, project: null as never },
      ];
      retirementRepo.find.mockResolvedValue(retirements as Retirement[]);

      const result = await service.getPortfolio('user-1');
      expect(result.projects[0].projectName).toBe('Unknown');
    });

    it('computes totalValue as totalRetired * creditPrice from config', async () => {
      const retirements: Partial<Retirement>[] = [
        {
          id: 'r-1',
          userId: 'user-1',
          projectId: 'proj-a',
          amount: 200,
          project: { name: 'Green Valley' } as never,
        },
        {
          id: 'r-2',
          userId: 'user-1',
          projectId: 'proj-a',
          amount: 300,
          project: { name: 'Green Valley' } as never,
        },
      ];
      retirementRepo.find.mockResolvedValue(retirements as Retirement[]);

      const result = await service.getPortfolio('user-1');

      expect(result.totalRetired).toBe(500);
      // Default CREDIT_PRICE_PER_UNIT is 1, so totalValue = 500 * 1 = 500
      expect(result.totalValue).toBe(500);
    });
  });

  // ── getRetirements ──────────────────────────────────────────────────────

  describe('getRetirements', () => {
    it('returns paginated retirements for a user', async () => {
      const retirements = [{ id: 'r-1' }, { id: 'r-2' }] as Retirement[];
      const qb = {
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getManyAndCount: jest.fn().mockResolvedValue([retirements, 2]),
        getRawOne: jest.fn(),
      };
      retirementRepo.createQueryBuilder.mockReturnValue(qb);

      const result = await service.getRetirements('user-1', {
        skip: 0,
        limit: 20,
        page: 1,
      } as never);

      expect(result.data).toHaveLength(2);
      expect(result.total).toBe(2);
    });

    it('filters by projectId and date range when provided', async () => {
      const qb = {
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
        getRawOne: jest.fn(),
      };
      retirementRepo.createQueryBuilder.mockReturnValue(qb);

      await service.getRetirements('user-1', {
        projectId: 'proj-1',
        startDate: '2026-01-01',
        endDate: '2026-12-31',
        skip: 0,
        limit: 20,
        page: 1,
      } as never);

      // andWhere should be called for projectId, startDate, and endDate
      expect(qb.andWhere).toHaveBeenCalledTimes(3);
    });
  });

  // ── findByProject ────────────────────────────────────────────────────────

  describe('findByProject', () => {
    it('returns all retirements for a given project', async () => {
      const retirements = [{ id: 'r-1', projectId: 'proj-1' }] as Retirement[];
      retirementRepo.find.mockResolvedValue(retirements);

      const result = await service.findByProject('proj-1');
      expect(result).toEqual(retirements);
      expect(retirementRepo.find).toHaveBeenCalledWith({
        where: { projectId: 'proj-1' },
        order: { retiredAt: 'DESC' },
      });
    });
  });
});

// ── getCreditOverview and getProjectCredits ──────────────────────────────

describe('CreditsService — getCreditOverview and getProjectCredits', () => {
  let service: CreditsService;
  let retirementRepo: {
    find: jest.Mock;
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let projectRepo: { find: jest.Mock; findOne: jest.Mock; count: jest.Mock };
  let stellarService: {
    getBalance: jest.Mock;
    getTotalSupply: jest.Mock;
    getTotalRetired: jest.Mock;
  };

  const makeQb = (overrides: Record<string, unknown> = {}) => ({
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    leftJoinAndSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    innerJoin: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(),
    addGroupBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
    getRawOne: jest.fn().mockResolvedValue({ total: '0' }),
    getRawMany: jest.fn().mockResolvedValue([]),
    ...overrides,
  });

  beforeEach(async () => {
    retirementRepo = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn(),
      save: jest.fn(),
      createQueryBuilder: jest.fn(() => makeQb()),
    };
    projectRepo = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(0),
    };
    stellarService = {
      getBalance: jest.fn().mockResolvedValue(new BigNumber(0)),
      getTotalSupply: jest.fn().mockResolvedValue(new BigNumber(0)),
      getTotalRetired: jest.fn().mockResolvedValue(new BigNumber(0)),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CreditsService,
        { provide: getRepositoryToken(Retirement), useValue: retirementRepo },
        { provide: getRepositoryToken(Project), useValue: projectRepo },
        {
          provide: getRepositoryToken(User),
          useValue: { find: jest.fn(), findOne: jest.fn() },
        },
        { provide: getQueueToken('retirements'), useValue: { add: jest.fn() } },
        { provide: ConfigService, useValue: { get: jest.fn() } },
        { provide: StellarService, useValue: stellarService },
      ],
    }).compile();

    service = module.get<CreditsService>(CreditsService);
  });

  // ── getCreditOverview ───────────────────────────────────────────────────

  describe('getCreditOverview', () => {
    it('returns DB values plus on-chain totals when the RPC is available', async () => {
      retirementRepo.createQueryBuilder.mockReturnValue(
        makeQb({
          getRawOne: jest.fn().mockResolvedValue({ total: '250' }),
          getRawMany: jest.fn().mockResolvedValue([
            { id: 'u-1', name: 'Alice', totalRetired: '150' },
            { id: 'u-2', name: 'Bob', totalRetired: '100' },
          ]),
        }),
      );
      projectRepo.count.mockResolvedValue(3);
      projectRepo.find.mockResolvedValue([
        { id: 'p-1', creditTokenAddress: 'C-token-1' },
        { id: 'p-2', creditTokenAddress: 'C-token-2' },
      ]);
      stellarService.getTotalSupply.mockResolvedValue(new BigNumber(1000));
      stellarService.getTotalRetired.mockResolvedValue(new BigNumber(200));

      const result = await service.getCreditOverview();

      expect(result.totalMinted).toBe(2000);
      expect(result.totalRetired).toBe(400);
      expect(result.activeProjects).toBe(3);
      expect(result.topRetirers).toEqual([
        { id: 'u-1', name: 'Alice', totalRetired: 150 },
        { id: 'u-2', name: 'Bob', totalRetired: 100 },
      ]);
      expect(result.onChainData).toEqual({ totalMinted: 2000, totalRetired: 400 });
      expect(result.stale).toBe(false);
      expect(stellarService.getTotalSupply).toHaveBeenCalledTimes(2);
    });

    it('degrades to DB values with stale: true when the Stellar RPC fails', async () => {
      retirementRepo.createQueryBuilder.mockReturnValue(
        makeQb({
          getRawOne: jest.fn().mockResolvedValue({ total: '250' }),
          getRawMany: jest
            .fn()
            .mockResolvedValue([{ id: 'u-1', name: 'Alice', totalRetired: '150' }]),
        }),
      );
      projectRepo.count.mockResolvedValue(3);
      projectRepo.find.mockResolvedValue([{ id: 'p-1', creditTokenAddress: 'C-token-1' }]);
      stellarService.getTotalSupply.mockRejectedValue(new Error('connection refused'));

      const result = await service.getCreditOverview();

      expect(result.stale).toBe(true);
      expect(result.onChainData).toBeNull();
      expect(result.totalMinted).toBeNull();
      // DB-sourced values survive the RPC failure
      expect(result.totalRetired).toBe(250);
      expect(result.activeProjects).toBe(3);
      expect(result.topRetirers).toEqual([{ id: 'u-1', name: 'Alice', totalRetired: 150 }]);
    });

    it('skips on-chain calls entirely when no project has a credit token address', async () => {
      retirementRepo.createQueryBuilder.mockReturnValue(
        makeQb({
          getRawOne: jest.fn().mockResolvedValue({ total: '250' }),
        }),
      );
      projectRepo.count.mockResolvedValue(3);
      projectRepo.find.mockResolvedValue([]);

      const result = await service.getCreditOverview();

      expect(result.totalMinted).toBeNull();
      expect(result.totalRetired).toBe(250);
      expect(result.onChainData).toBeNull();
      expect(result.stale).toBe(false);
      expect(stellarService.getTotalSupply).not.toHaveBeenCalled();
      expect(stellarService.getTotalRetired).not.toHaveBeenCalled();
    });
  });

  // ── getProjectCredits ───────────────────────────────────────────────────

  describe('getProjectCredits', () => {
    it('returns on-chain balance and totals joined with local retirements', async () => {
      projectRepo.findOne.mockResolvedValue({
        id: 'p-1',
        creditTokenAddress: 'C-token-1',
        owner: { wallet: 'G-owner-1' },
      });
      retirementRepo.find.mockResolvedValue([
        { id: 'r-1', projectId: 'p-1', amount: 100 },
        { id: 'r-2', projectId: 'p-1', amount: 50 },
      ] as never);
      stellarService.getBalance.mockResolvedValue(new BigNumber(500));
      stellarService.getTotalSupply.mockResolvedValue(new BigNumber(1000));
      stellarService.getTotalRetired.mockResolvedValue(new BigNumber(200));

      const result = await service.getProjectCredits('p-1');

      expect(result.projectId).toBe('p-1');
      expect(result.creditTokenAddress).toBe('C-token-1');
      expect(result.onChainBalance).toBe(500);
      expect(result.totalMinted).toBe(1000);
      expect(result.totalRetired).toBe(200);
      expect(result.retirements).toHaveLength(2);
      expect(result.onChainData).toEqual({
        balance: 500,
        totalMinted: 1000,
        totalRetired: 200,
      });
      expect(result.stale).toBe(false);
      expect(stellarService.getBalance).toHaveBeenCalledWith('C-token-1', 'G-owner-1');
    });

    it('returns null on-chain values without an RPC call when creditTokenAddress is null', async () => {
      projectRepo.findOne.mockResolvedValue({
        id: 'p-1',
        creditTokenAddress: null,
        owner: { wallet: 'G-owner-1' },
      });
      retirementRepo.find.mockResolvedValue([
        { id: 'r-1', projectId: 'p-1', amount: 100 },
        { id: 'r-2', projectId: 'p-1', amount: 50 },
      ] as never);

      const result = await service.getProjectCredits('p-1');

      expect(result.creditTokenAddress).toBeNull();
      expect(result.onChainBalance).toBeNull();
      expect(result.totalMinted).toBeNull();
      // DB-sourced total stays available
      expect(result.totalRetired).toBe(150);
      expect(result.retirements).toHaveLength(2);
      expect(result.onChainData).toBeNull();
      expect(result.stale).toBe(false);
      expect(stellarService.getBalance).not.toHaveBeenCalled();
      expect(stellarService.getTotalSupply).not.toHaveBeenCalled();
      expect(stellarService.getTotalRetired).not.toHaveBeenCalled();
    });

    it('degrades to DB values with stale: true when the Stellar RPC fails', async () => {
      projectRepo.findOne.mockResolvedValue({
        id: 'p-1',
        creditTokenAddress: 'C-token-1',
        owner: { wallet: 'G-owner-1' },
      });
      retirementRepo.find.mockResolvedValue([
        { id: 'r-1', projectId: 'p-1', amount: 100 },
        { id: 'r-2', projectId: 'p-1', amount: 50 },
      ] as never);
      stellarService.getBalance.mockRejectedValue(new Error('RPC timeout'));

      const result = await service.getProjectCredits('p-1');

      expect(result.stale).toBe(true);
      expect(result.onChainData).toBeNull();
      expect(result.onChainBalance).toBeNull();
      expect(result.totalMinted).toBeNull();
      expect(result.totalRetired).toBe(150);
      expect(result.retirements).toHaveLength(2);
    });

    it('keeps on-chain supply/retired but null balance when the owner has no wallet', async () => {
      projectRepo.findOne.mockResolvedValue({
        id: 'p-1',
        creditTokenAddress: 'C-token-1',
        owner: null,
      });
      retirementRepo.find.mockResolvedValue([]);
      stellarService.getTotalSupply.mockResolvedValue(new BigNumber(1000));
      stellarService.getTotalRetired.mockResolvedValue(new BigNumber(200));

      const result = await service.getProjectCredits('p-1');

      expect(result.onChainBalance).toBeNull();
      expect(result.totalMinted).toBe(1000);
      expect(result.totalRetired).toBe(200);
      expect(result.onChainData).toEqual({
        balance: null,
        totalMinted: 1000,
        totalRetired: 200,
      });
      expect(result.stale).toBe(false);
      expect(stellarService.getBalance).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when the project does not exist', async () => {
      projectRepo.findOne.mockResolvedValue(null);

      await expect(service.getProjectCredits('missing')).rejects.toThrow(NotFoundException);
    });
  });
});
