import { Test, TestingModule } from '@nestjs/testing';
import { CreditsController } from './credits.controller';
import { CreditsService } from './credits.service';
import { RetireCreditsDto } from './dto/retire-credits.dto';
import { CreditQueryDto } from './dto/credit-query.dto';
import { Retirement } from './entities/retirement.entity';
describe('CreditsController', () => {
  let controller: CreditsController;
  let creditsService: jest.Mocked<CreditsService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [CreditsController],
      providers: [
        {
          provide: CreditsService,
          useValue: {
            getPortfolio: jest.fn(),
            retire: jest.fn(),
            getRetirements: jest.fn(),
            getCertificate: jest.fn(),
            getTotalRetired: jest.fn(),
            getCreditOverview: jest.fn(),
            getProjectCredits: jest.fn(),
          },
        },
      ],
    }).compile();

    controller = module.get<CreditsController>(CreditsController);
    creditsService = module.get<CreditsService>(CreditsService) as jest.Mocked<CreditsService>;
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('getPortfolio', () => {
    it('should call creditsService.getPortfolio with the userId from @CurrentUser', async () => {
      const userId = 'user-123';
      const expected = { totalRetired: 100, totalValue: 100, projects: [] };
      creditsService.getPortfolio.mockResolvedValue(expected);

      const result = await controller.getPortfolio(userId);

      expect(creditsService.getPortfolio).toHaveBeenCalledWith(userId);
      expect(result).toBe(expected);
    });
  });

  describe('retire', () => {
    it('should call creditsService.retire with userId and dto, return the retirement', async () => {
      const userId = 'user-123';
      const dto: RetireCreditsDto = {
        projectId: 'proj-1',
        amount: 10,
        purpose: 'Offset carbon',
      };
      const expected = { id: 'ret-1' } as Retirement;
      creditsService.retire.mockResolvedValue(expected);

      const result = await controller.retire(userId, dto);

      expect(creditsService.retire).toHaveBeenCalledWith(userId, dto);
      expect(result).toBe(expected);
    });
  });

  describe('getRetirements', () => {
    it('should call creditsService.getRetirements and return a PaginatedResponseDto', async () => {
      const userId = 'user-123';
      const query = { page: 1, limit: 20 } as CreditQueryDto;
      const retirements = [{ id: 'ret-1' } as Retirement];
      creditsService.getRetirements.mockResolvedValue({
        data: retirements,
        total: 1,
        page: 1,
        limit: 20,
      });

      const result = await controller.getRetirements(userId, query);

      expect(creditsService.getRetirements).toHaveBeenCalledWith(userId, query);
      expect(result).toEqual({
        success: true,
        data: retirements,
        meta: { mode: 'offset', total: 1, page: 1, limit: 20, totalPages: 1 },
        timestamp: expect.any(String),
      });
    });
  });

  describe('getCertificate', () => {
    it('should call creditsService.getCertificate with id and userId', async () => {
      const id = 'ret-1';
      const userId = 'user-123';
      const expected = { id: 'ret-1' } as Retirement;
      creditsService.getCertificate.mockResolvedValue(expected);

      const result = await controller.getCertificate(id, userId);

      expect(creditsService.getCertificate).toHaveBeenCalledWith(id, userId);
      expect(result).toBe(expected);
    });
  });

  describe('getTotalRetired', () => {
    it('should call creditsService.getTotalRetired and return { total }', async () => {
      creditsService.getTotalRetired.mockResolvedValue(500);

      const result = await controller.getTotalRetired();

      expect(creditsService.getTotalRetired).toHaveBeenCalledWith();
      expect(result).toEqual({ total: 500 });
    });
  });

  describe('getCreditOverview', () => {
    it('should call creditsService.getCreditOverview and return the overview', async () => {
      const expected = {
        totalMinted: 2000,
        totalRetired: 400,
        activeProjects: 3,
        topRetirers: [{ id: 'u-1', name: 'Alice', totalRetired: 150 }],
        onChainData: { totalMinted: 2000, totalRetired: 400 },
        stale: false,
      };
      creditsService.getCreditOverview.mockResolvedValue(expected);

      const result = await controller.getCreditOverview();

      expect(creditsService.getCreditOverview).toHaveBeenCalledWith();
      expect(result).toBe(expected);
    });
  });

  describe('getProjectCredits', () => {
    it('should call creditsService.getProjectCredits with the projectId param', async () => {
      const projectId = 'proj-123';
      const expected = {
        projectId,
        creditTokenAddress: null,
        onChainBalance: null,
        totalMinted: null,
        totalRetired: 0,
        retirements: [],
        onChainData: null,
        stale: false,
      };
      creditsService.getProjectCredits.mockResolvedValue(expected);

      const result = await controller.getProjectCredits(projectId);

      expect(creditsService.getProjectCredits).toHaveBeenCalledWith(projectId);
      expect(result).toBe(expected);
    });
  });
});
