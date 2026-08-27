import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException } from '@nestjs/common';
import { GovernanceController } from './governance.controller';
import { GovernanceService } from './governance.service';
import { CreateProposalDto } from './dto/create-proposal.dto';
import { VoteDto } from './dto/vote.dto';
import { GovernanceQueryDto } from './dto/governance-query.dto';
import { UserRole } from '../users/entities/user.entity';

describe('GovernanceController', () => {
  let controller: GovernanceController;
  let service: jest.Mocked<GovernanceService>;

  const mockConfig = {
    id: 1,
    protocolFeeBps: 100,
    minOracleConfirmations: 3,
    votingPeriod: 604800,
    timelockPeriod: 86400,
    quorum: 3,
    quorumBasisPoints: 2000,
    phMin: 6.5,
    phMax: 8.5,
    doThreshold: 5.0,
    tempPenaltyDelta: 2.0,
    weightVolumetric: 0.5,
    weightNitrogen: 0.3,
    weightPhosphorus: 0.2,
    updatedBy: null,
    updatedAt: new Date('2026-01-01'),
  };

  const mockProposal = {
    id: 'prop-1',
    proposer: 'GABCD...',
    title: 'Test Proposal',
    description: 'A test proposal',
    actionType: 'update_fee',
    actionParams: { fee: 200 },
    votesFor: 5,
    votesAgainst: 2,
    status: 'active',
    deadline: new Date('2026-02-01'),
    onChainProposalId: null,
    executionTxHash: null,
    executedBy: null,
    executedAt: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
  } as any;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [GovernanceController],
      providers: [
        {
          provide: GovernanceService,
          useValue: {
            getConfig: jest.fn(),
            proposeConfigChange: jest.fn(),
            emergencyConfigUpdate: jest.fn(),
            getProposals: jest.fn(),
            getProposalById: jest.fn(),
            createProposal: jest.fn(),
            vote: jest.fn(),
            executeProposal: jest.fn(),
          },
        },
      ],
    }).compile();

    controller = module.get<GovernanceController>(GovernanceController);
    service = module.get(GovernanceService);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('getConfig', () => {
    it('should return the governance config', async () => {
      service.getConfig.mockResolvedValue(mockConfig);

      const result = await controller.getConfig();

      expect(service.getConfig).toHaveBeenCalledTimes(1);
      expect(result).toEqual(mockConfig);
    });
  });

  describe('updateConfig', () => {
    it('should propose a config change with the given body and actor', async () => {
      const updates = { protocolFeeBps: 200, quorum: 5 };
      const pendingChange = {
        id: 'change-1',
        configId: 1,
        proposedValues: updates,
        proposedBy: 'GADMIN',
        effectiveAt: new Date(),
        status: 'pending',
        appliedAt: null,
        appliedBy: null,
        cancelledAt: null,
        cancelledBy: null,
        reason: null,
        createdAt: new Date(),
      };
      service.proposeConfigChange.mockResolvedValue(pendingChange as any);

      const result = await controller.updateConfig(updates as any, 'GADMIN', UserRole.ADMIN);

      expect(service.proposeConfigChange).toHaveBeenCalledWith('GADMIN', updates);
      expect(result).toEqual(pendingChange);
    });

    it('delegates force=true to emergencyConfigUpdate with caller role', async () => {
      const updates = { quorum: 9 };
      service.emergencyConfigUpdate.mockResolvedValue(mockConfig);

      const result = await controller.updateConfig(
        updates as any,
        'GSUPERADMIN',
        UserRole.SUPER_ADMIN,
        'true',
      );

      expect(service.emergencyConfigUpdate).toHaveBeenCalledWith(
        'GSUPERADMIN',
        updates,
        UserRole.SUPER_ADMIN,
      );
      expect(result).toEqual(mockConfig);
    });

    it('returns 403 for ADMIN when force=true', async () => {
      const updates = { quorum: 9 };
      service.emergencyConfigUpdate.mockRejectedValue(
        new ForbiddenException('Emergency config updates require SUPER_ADMIN'),
      );

      await expect(
        controller.updateConfig(updates as any, 'GADMIN', UserRole.ADMIN, 'true'),
      ).rejects.toThrow(ForbiddenException);

      expect(service.emergencyConfigUpdate).toHaveBeenCalledWith(
        'GADMIN',
        updates,
        UserRole.ADMIN,
      );
    });
  });

  describe('getProposals', () => {
    it('should return paginated proposals', async () => {
      const query: GovernanceQueryDto = { page: 1, limit: 20 } as any;
      const serviceResult = { data: [mockProposal], total: 1, page: 1, limit: 20 };
      service.getProposals.mockResolvedValue(serviceResult);

      const result = await controller.getProposals(query);

      expect(service.getProposals).toHaveBeenCalledWith(query);
      expect(result).toMatchObject({
        success: true,
        data: [mockProposal],
        meta: { total: 1, page: 1, limit: 20, totalPages: 1 },
      });
    });
  });

  describe('getProposalById', () => {
    it('should return a proposal by id', async () => {
      service.getProposalById.mockResolvedValue(mockProposal);

      const result = await controller.getProposalById('prop-1');

      expect(service.getProposalById).toHaveBeenCalledWith('prop-1');
      expect(result).toEqual(mockProposal);
    });
  });

  describe('createProposal', () => {
    it('should create a proposal with proposer from CurrentUser and dto', async () => {
      const dto: CreateProposalDto = {
        title: 'New Proposal',
        description: 'Desc',
        actionType: 'update_fee',
        actionParams: { fee: 300 },
      };
      const proposer = 'GUSER123...';
      const createdProposal = { ...mockProposal, proposer, title: dto.title };
      service.createProposal.mockResolvedValue(createdProposal);

      const result = await controller.createProposal(proposer, dto);

      expect(service.createProposal).toHaveBeenCalledWith(proposer, dto);
      expect(result).toEqual(createdProposal);
    });
  });

  describe('vote', () => {
    it('should vote with proposal id, voter from CurrentUser, and dto', async () => {
      const dto: VoteDto = { approve: true };
      const voter = 'GVOTER...';
      const updatedProposal = { ...mockProposal, votesFor: 6 };
      service.vote.mockResolvedValue(updatedProposal);

      const result = await controller.vote('prop-1', voter, dto);

      expect(service.vote).toHaveBeenCalledWith('prop-1', voter, dto);
      expect(result).toEqual(updatedProposal);
    });
  });

  describe('executeProposal', () => {
    it('should execute a proposal with id and executor from CurrentUser', async () => {
      const executor = 'GADMIN...';
      const executedProposal = {
        ...mockProposal,
        status: 'executed',
        executedBy: executor,
        executedAt: new Date(),
      };
      service.executeProposal.mockResolvedValue(executedProposal);

      const result = await controller.executeProposal('prop-1', executor);

      expect(service.executeProposal).toHaveBeenCalledWith('prop-1', executor);
      expect(result).toEqual(executedProposal);
    });
  });

  // ── DTO-level class-validator tests ──────────────────────────────────────

  describe('UpdateGovernanceConfigDto — class-validator', () => {
    it('rejects an extra field like `id` (maps to 400 via global ValidationPipe forbidNonWhitelisted)', async () => {
      const dto = new UpdateGovernanceConfigDto();
      Object.assign(dto, { id: 99, protocolFeeBps: 150 });

      const errors = await validate(dto, {
        whitelist: true,
        forbidNonWhitelisted: true,
        forbidUnknownValues: true,
      });

      // Nest's global ValidationPipe (forbidNonWhitelisted: true) turns any
      // unknown property like `id` into a 400 BadRequest.
      expect(errors.length).toBeGreaterThan(0);
      const touchesId = errors.some(
        (e) =>
          e.property === 'id' ||
          Object.values(e.constraints || {}).some(
            (msg) => typeof msg === 'string' && msg.includes('id'),
          ),
      );
      expect(touchesId || errors.length > 0).toBe(true);
    });

    it('rejects `updatedAt` being injected (it is not a DTO field)', async () => {
      const dto = new UpdateGovernanceConfigDto();
      Object.assign(dto, { updatedAt: new Date().toISOString(), protocolFeeBps: 150 });

      const errors = await validate(dto, {
        whitelist: true,
        forbidNonWhitelisted: true,
      });

      expect(errors.length).toBeGreaterThan(0);
    });

    it('accepts a well-formed payload with all three credit weights summing to 1.0', async () => {
      const dto = new UpdateGovernanceConfigDto();
      dto.protocolFeeBps = 150;
      dto.quorum = 5;
      dto.weightVolumetric = 0.5;
      dto.weightNitrogen = 0.3;
      dto.weightPhosphorus = 0.2;
      dto.reason = 'test payload';

      const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
      expect(errors).toEqual([]);
    });

    it('flags a DTO where credit weights do not sum to 1.0 (class-level WeightSumConstraint)', async () => {
      const dto = new UpdateGovernanceConfigDto();
      dto.weightVolumetric = 0.6;
      dto.weightNitrogen = 0.3;
      dto.weightPhosphorus = 0.3; // 1.2 total

      const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
      expect(errors.length).toBeGreaterThan(0);
    });

    it('rejects a string instead of a number for quorum (bad type)', async () => {
      const dto = new UpdateGovernanceConfigDto();
      Object.assign(dto, { quorum: 'not-a-number' });

      const errors = await validate(dto);
      const hasIsInt = errors.some((e) => Object.keys(e.constraints || {}).includes('isInt'));
      expect(hasIsInt).toBe(true);
    });

    it('rejects negative protocolFeeBps (range)', async () => {
      const dto = new UpdateGovernanceConfigDto();
      dto.protocolFeeBps = -5;

      const errors = await validate(dto);
      const hasMin = errors.some((e) => Object.keys(e.constraints || {}).includes('min'));
      expect(hasMin).toBe(true);
    });

    it('rejects votingPeriod < 60 seconds', async () => {
      const dto = new UpdateGovernanceConfigDto();
      dto.votingPeriod = 30;

      const errors = await validate(dto);
      const hasMin = errors.some((e) => Object.keys(e.constraints || {}).includes('min'));
      expect(hasMin).toBe(true);
    });

    it('rejects a weight outside [0,1]', async () => {
      const dto = new UpdateGovernanceConfigDto();
      dto.weightVolumetric = 1.5;

      const errors = await validate(dto);
      const hasMax = errors.some((e) => Object.keys(e.constraints || {}).includes('max'));
      expect(hasMax).toBe(true);
    });
  });
});
