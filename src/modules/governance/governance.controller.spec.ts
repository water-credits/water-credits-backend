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
});
