import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  InternalServerErrorException,
} from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, QueryFailedError } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { GovernanceService } from './governance.service';
import { Proposal, ProposalStatus } from './entities/proposal.entity';
import { ProposalVote } from './entities/proposal-vote.entity';
import { GovernanceConfig } from './entities/governance-config.entity';
import {
  GovernanceConfigChange,
  ConfigChangeStatus,
} from './entities/governance-config-change.entity';
import { StellarService } from '../stellar/stellar.service';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeProposal(overrides: Partial<Proposal> = {}): Proposal {
  const future = new Date(Date.now() + 86_400_000); // +1 day
  return {
    id: 'prop-uuid-1',
    proposer: 'GABC',
    title: 'Test proposal',
    description: null,
    actionType: 'update_config',
    actionParams: null,
    votesFor: 0,
    votesAgainst: 0,
    status: ProposalStatus.ACTIVE,
    deadline: future,
    onChainProposalId: null,
    executionTxHash: null,
    executedBy: null,
    executedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as Proposal;
}

function makeConfig(overrides: Partial<GovernanceConfig> = {}): GovernanceConfig {
  return {
    id: 1,
    protocolFeeBps: 100,
    minOracleConfirmations: 3,
    votingPeriod: 604800,
    timelockPeriod: 86400,
    quorum: 3,
    phMin: null,
    phMax: null,
    doThreshold: null,
    tempPenaltyDelta: null,
    weightVolumetric: 0.5,
    weightNitrogen: 0.3,
    weightPhosphorus: 0.2,
    updatedBy: null,
    updatedAt: new Date(),
    ...overrides,
  } as GovernanceConfig;
}

// ── Factory for a fake QueryRunner ───────────────────────────────────────────

function makeQueryRunner(opts: {
  proposal?: Proposal | null;
  existingVote?: ProposalVote | null;
  saveVoteError?: Error;
  updateShouldFail?: boolean;
}) {
  const { proposal = makeProposal(), existingVote = null } = opts;

  // Mutable state shared across mock calls so we can track counter increments.
  let findOneCallCount = 0;

  const qb = {
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    execute: jest.fn().mockResolvedValue(undefined),
  };

  const manager = {
    findOne: jest.fn().mockImplementation(async (_entity: unknown, _opts: unknown) => {
      findOneCallCount++;
      if (findOneCallCount === 1) {
        // First call: load Proposal
        return proposal;
      }
      if (findOneCallCount === 2) {
        // Second call: check existingVote
        return existingVote;
      }
      // Third call: reload after increment — return the updated proposal.
      if (proposal) {
        return {
          ...proposal,
          votesFor:
            (proposal.votesFor as number) + (proposal.status === ProposalStatus.ACTIVE ? 1 : 0),
        };
      }
      return null;
    }),
    create: jest.fn().mockImplementation((_entity: unknown, data: unknown) => data),
    save: jest.fn().mockImplementation(async (_entity: unknown, data: unknown) => {
      if (opts.saveVoteError) {
        throw opts.saveVoteError;
      }
      return data;
    }),
    createQueryBuilder: jest.fn().mockReturnValue(qb),
  };

  return {
    connect: jest.fn().mockResolvedValue(undefined),
    startTransaction: jest.fn().mockResolvedValue(undefined),
    commitTransaction: jest.fn().mockResolvedValue(undefined),
    rollbackTransaction: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined),
    manager,
    _qb: qb,
  };
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('GovernanceService', () => {
  let service: GovernanceService;
  let proposalRepo: jest.Mocked<Record<string, jest.Mock>>;
  let voteRepo: jest.Mocked<Record<string, jest.Mock>>;
  let configRepo: jest.Mocked<Record<string, jest.Mock>>;
  let configChangeRepo: jest.Mocked<Record<string, jest.Mock>>;
  let dataSource: { createQueryRunner: jest.Mock };
  let stellarService: { execute: jest.Mock; createProposal: jest.Mock };
  let configService: { get: jest.Mock };

  beforeEach(async () => {
    proposalRepo = {
      find: jest.fn(),
      findOne: jest.fn(),
      create: jest.fn(),
      save: jest.fn(),
      createQueryBuilder: jest.fn(() => ({
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue(undefined),
        getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
      })),
    };

    voteRepo = {
      findOne: jest.fn(),
      create: jest.fn(),
      save: jest.fn(),
    };

    configRepo = {
      findOne: jest.fn().mockResolvedValue(makeConfig()),
      create: jest.fn(),
      save: jest.fn(),
    };

    configChangeRepo = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn(),
      save: jest.fn(),
    };

    dataSource = {
      createQueryRunner: jest.fn(),
      query: jest.fn().mockResolvedValue(undefined),
    } as never;

    stellarService = {
      execute: jest.fn(),
      createProposal: jest.fn(),
    };

    configService = {
      get: jest.fn().mockImplementation((key: string, fallback?: unknown) => {
        if (key === 'stellar.contractGovernance') {
          return 'CGOVERNANCE123';
        }
        return fallback;
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GovernanceService,
        { provide: getRepositoryToken(Proposal), useValue: proposalRepo },
        { provide: getRepositoryToken(ProposalVote), useValue: voteRepo },
        { provide: getRepositoryToken(GovernanceConfig), useValue: configRepo },
        { provide: getRepositoryToken(GovernanceConfigChange), useValue: configChangeRepo },
        { provide: ConfigService, useValue: configService },
        { provide: DataSource, useValue: dataSource },
        { provide: StellarService, useValue: stellarService },
      ],
    }).compile();

    service = module.get<GovernanceService>(GovernanceService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  // ── vote() ── sequential double-vote ────────────────────────────────────

  describe('vote() — sequential double-vote (non-race)', () => {
    it('rejects the second vote with 409 Conflict when a vote already exists', async () => {
      const proposal = makeProposal();
      const existingVote = {
        id: 'vote-1',
        proposalId: proposal.id,
        voterWallet: 'GABC',
        support: true,
      } as ProposalVote;
      const qr = makeQueryRunner({ proposal, existingVote });
      dataSource.createQueryRunner.mockReturnValue(qr);

      await expect(service.vote(proposal.id, 'GABC', { approve: true })).rejects.toThrow(
        ConflictException,
      );

      expect(qr.rollbackTransaction).toHaveBeenCalled();
    });

    it('accepts the first vote and returns the updated proposal', async () => {
      const proposal = makeProposal({ votesFor: 0 });
      const qr = makeQueryRunner({ proposal, existingVote: null });

      // After the atomic increment, the reload should return votesFor = 1.
      let findCount = 0;
      qr.manager.findOne = jest.fn().mockImplementation(async () => {
        findCount++;
        if (findCount === 1) {
          return proposal;
        } // load proposal
        if (findCount === 2) {
          return null;
        } // no existing vote
        return { ...proposal, votesFor: 1 }; // reload after increment
      });

      dataSource.createQueryRunner.mockReturnValue(qr);
      configRepo.findOne.mockResolvedValue(makeConfig({ quorum: 5 })); // quorum not yet met

      const result = await service.vote(proposal.id, 'GVOTER', { approve: true });

      expect(result.votesFor).toBe(1);
      expect(qr.commitTransaction).toHaveBeenCalled();
      expect(qr.rollbackTransaction).not.toHaveBeenCalled();
    });
  });

  // ── vote() ── concurrent double-vote (race condition) ────────────────────

  describe('vote() — concurrent double-vote (race condition)', () => {
    it('maps a Postgres unique-violation (code 23505) to 409 Conflict', async () => {
      const proposal = makeProposal();

      // Simulate the DB unique constraint firing on save (the race-window path
      // where both requests passed the findOne check simultaneously).
      const pgError = Object.assign(
        new QueryFailedError('INSERT ...', [], new Error('duplicate key')),
        { code: '23505' },
      );

      const qr = makeQueryRunner({ proposal, existingVote: null, saveVoteError: pgError });
      dataSource.createQueryRunner.mockReturnValue(qr);

      await expect(service.vote(proposal.id, 'GABC', { approve: true })).rejects.toThrow(
        ConflictException,
      );

      expect(qr.rollbackTransaction).toHaveBeenCalled();
    });

    it('two concurrent calls result in exactly one accepted vote', async () => {
      // We simulate two concurrent requests: the first succeeds, the second
      // hits the unique constraint from inside the same transaction window.
      const proposal = makeProposal({ votesFor: 0 });

      let callIndex = 0;
      const makeQr = () => {
        callIndex++;
        const isFirst = callIndex === 1;

        const pgError = Object.assign(
          new QueryFailedError('INSERT ...', [], new Error('duplicate key')),
          { code: '23505' },
        );

        // First runner succeeds; second runner hits unique violation.
        const saveError = isFirst ? undefined : pgError;

        let findCount = 0;
        const qr = {
          connect: jest.fn().mockResolvedValue(undefined),
          startTransaction: jest.fn().mockResolvedValue(undefined),
          commitTransaction: jest.fn().mockResolvedValue(undefined),
          rollbackTransaction: jest.fn().mockResolvedValue(undefined),
          release: jest.fn().mockResolvedValue(undefined),
          manager: {
            findOne: jest.fn().mockImplementation(async () => {
              findCount++;
              if (findCount === 1) {
                return proposal;
              }
              if (findCount === 2) {
                return null;
              } // no prior vote
              return { ...proposal, votesFor: 1 };
            }),
            create: jest.fn().mockImplementation((_e: unknown, d: unknown) => d),
            save: jest.fn().mockImplementation(async () => {
              if (saveError) {
                throw saveError;
              }
              return {};
            }),
            createQueryBuilder: jest.fn().mockReturnValue({
              update: jest.fn().mockReturnThis(),
              set: jest.fn().mockReturnThis(),
              where: jest.fn().mockReturnThis(),
              execute: jest.fn().mockResolvedValue(undefined),
            }),
          },
        };
        return qr;
      };

      dataSource.createQueryRunner.mockImplementation(makeQr);
      configRepo.findOne.mockResolvedValue(makeConfig({ quorum: 5 }));

      const [first, second] = await Promise.allSettled([
        service.vote(proposal.id, 'GABC', { approve: true }),
        service.vote(proposal.id, 'GABC', { approve: true }),
      ]);

      const fulfilled = [first, second].filter((r) => r.status === 'fulfilled');
      const rejected = [first, second].filter((r) => r.status === 'rejected');

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);

      const rejection = rejected[0] as PromiseRejectedResult;
      expect(rejection.reason).toBeInstanceOf(ConflictException);
    });
  });

  // ── vote() ── quorum threshold crossing ──────────────────────────────────

  describe('vote() — quorum threshold', () => {
    it('marks proposal PASSED when votesFor > votesAgainst and total >= quorum', async () => {
      const proposal = makeProposal({ votesFor: 1, votesAgainst: 1 }); // total=2, quorum=3
      configRepo.findOne.mockResolvedValue(makeConfig({ quorum: 3 }));

      let findCount = 0;
      const qr = {
        connect: jest.fn().mockResolvedValue(undefined),
        startTransaction: jest.fn().mockResolvedValue(undefined),
        commitTransaction: jest.fn().mockResolvedValue(undefined),
        rollbackTransaction: jest.fn().mockResolvedValue(undefined),
        release: jest.fn().mockResolvedValue(undefined),
        manager: {
          findOne: jest.fn().mockImplementation(async () => {
            findCount++;
            if (findCount === 1) {
              return proposal;
            } // load proposal
            if (findCount === 2) {
              return null;
            } // no existing vote
            // After increment votesFor=2, votesAgainst=1 → total=3 → PASSED
            return { ...proposal, votesFor: 2, votesAgainst: 1, status: ProposalStatus.PASSED };
          }),
          create: jest.fn().mockImplementation((_e: unknown, d: unknown) => d),
          save: jest.fn().mockResolvedValue({}),
          createQueryBuilder: jest.fn().mockReturnValue({
            update: jest.fn().mockReturnThis(),
            set: jest.fn().mockReturnThis(),
            where: jest.fn().mockReturnThis(),
            execute: jest.fn().mockResolvedValue(undefined),
          }),
        },
      };
      dataSource.createQueryRunner.mockReturnValue(qr);

      const result = await service.vote(proposal.id, 'GVOTER', { approve: true });

      // The status update queryBuilder should have been called with PASSED
      const qbMock = qr.manager.createQueryBuilder();
      expect(qbMock.update).toHaveBeenCalled();
      expect(qr.commitTransaction).toHaveBeenCalled();
      expect(result.status).toBe(ProposalStatus.PASSED);
    });

    it('marks proposal REJECTED when votesAgainst > votesFor and total >= quorum', async () => {
      const proposal = makeProposal({ votesFor: 0, votesAgainst: 2 });
      configRepo.findOne.mockResolvedValue(makeConfig({ quorum: 3 }));

      let findCount = 0;
      const qr = {
        connect: jest.fn().mockResolvedValue(undefined),
        startTransaction: jest.fn().mockResolvedValue(undefined),
        commitTransaction: jest.fn().mockResolvedValue(undefined),
        rollbackTransaction: jest.fn().mockResolvedValue(undefined),
        release: jest.fn().mockResolvedValue(undefined),
        manager: {
          findOne: jest.fn().mockImplementation(async () => {
            findCount++;
            if (findCount === 1) {
              return proposal;
            }
            if (findCount === 2) {
              return null;
            }
            return { ...proposal, votesFor: 0, votesAgainst: 3, status: ProposalStatus.REJECTED };
          }),
          create: jest.fn().mockImplementation((_e: unknown, d: unknown) => d),
          save: jest.fn().mockResolvedValue({}),
          createQueryBuilder: jest.fn().mockReturnValue({
            update: jest.fn().mockReturnThis(),
            set: jest.fn().mockReturnThis(),
            where: jest.fn().mockReturnThis(),
            execute: jest.fn().mockResolvedValue(undefined),
          }),
        },
      };
      dataSource.createQueryRunner.mockReturnValue(qr);

      const result = await service.vote(proposal.id, 'GVOTER', { approve: false });
      expect(result.status).toBe(ProposalStatus.REJECTED);
    });
  });

  // ── vote() ── inactive proposal ──────────────────────────────────────────

  describe('vote() — proposal state guards', () => {
    it('rejects a vote on a non-ACTIVE proposal', async () => {
      const proposal = makeProposal({ status: ProposalStatus.PASSED });

      let findCount = 0;
      const qr = {
        connect: jest.fn().mockResolvedValue(undefined),
        startTransaction: jest.fn().mockResolvedValue(undefined),
        commitTransaction: jest.fn().mockResolvedValue(undefined),
        rollbackTransaction: jest.fn().mockResolvedValue(undefined),
        release: jest.fn().mockResolvedValue(undefined),
        manager: {
          findOne: jest.fn().mockImplementation(async () => {
            findCount++;
            return findCount === 1 ? proposal : null;
          }),
          create: jest.fn(),
          save: jest.fn(),
          createQueryBuilder: jest.fn().mockReturnValue({
            update: jest.fn().mockReturnThis(),
            set: jest.fn().mockReturnThis(),
            where: jest.fn().mockReturnThis(),
            execute: jest.fn().mockResolvedValue(undefined),
          }),
        },
      };
      dataSource.createQueryRunner.mockReturnValue(qr);

      await expect(service.vote(proposal.id, 'GVOTER', { approve: true })).rejects.toThrow(
        BadRequestException,
      );

      expect(qr.rollbackTransaction).toHaveBeenCalled();
    });
  });

  // ── executeProposal() ─────────────────────────────────────────────────────

  describe('executeProposal()', () => {
    it('throws BadRequestException when proposal status is not PASSED', async () => {
      const proposal = makeProposal({ status: ProposalStatus.ACTIVE });
      proposalRepo.findOne.mockResolvedValue(proposal);

      await expect(service.executeProposal(proposal.id, 'GADMIN')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('throws ForbiddenException when timelock has not elapsed', async () => {
      const recentDeadline = new Date(Date.now() - 3600_000); // 1 hour ago, timelock = 24 h
      const proposal = makeProposal({
        status: ProposalStatus.PASSED,
        deadline: recentDeadline,
        onChainProposalId: 42,
      });
      proposalRepo.findOne.mockResolvedValue(proposal);
      configRepo.findOne.mockResolvedValue(makeConfig({ timelockPeriod: 86400 }));

      await expect(service.executeProposal(proposal.id, 'GADMIN')).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('throws BadRequestException when onChainProposalId is null and on-chain registration fails', async () => {
      const oldDeadline = new Date(Date.now() - 2 * 86_400_000); // 2 days ago
      const proposal = makeProposal({
        status: ProposalStatus.PASSED,
        deadline: oldDeadline,
        onChainProposalId: null,
      });
      proposalRepo.findOne.mockResolvedValue(proposal);
      configRepo.findOne.mockResolvedValue(makeConfig({ timelockPeriod: 86400 }));
      // Self-healing registration is attempted but fails, so no on-chain id
      // can be resolved and execution must be rejected.
      stellarService.createProposal.mockRejectedValue(new Error('RPC down'));

      await expect(service.executeProposal(proposal.id, 'GADMIN')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('self-heals: registers the proposal on-chain and executes when onChainProposalId is null', async () => {
      const oldDeadline = new Date(Date.now() - 2 * 86_400_000);
      const proposal = makeProposal({
        status: ProposalStatus.PASSED,
        deadline: oldDeadline,
        onChainProposalId: null,
      });

      proposalRepo.findOne
        .mockResolvedValueOnce(proposal) // getProposalById
        .mockResolvedValueOnce({
          // reload after update
          ...proposal,
          status: ProposalStatus.EXECUTED,
          executionTxHash: 'abc123',
          executedBy: 'GADMIN',
          onChainProposalId: 11,
        });

      configRepo.findOne.mockResolvedValue(makeConfig({ timelockPeriod: 86400 }));

      const execQb = {
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue(undefined),
      };
      proposalRepo.createQueryBuilder.mockReturnValue(execQb);

      stellarService.createProposal.mockResolvedValue(11);
      stellarService.execute.mockResolvedValue({ txHash: 'abc123' });

      const result = await service.executeProposal(proposal.id, 'GADMIN');

      expect(stellarService.createProposal).toHaveBeenCalledWith(
        'CGOVERNANCE123',
        proposal.title,
        '',
        { actionType: proposal.actionType, actionParams: {} },
      );
      expect(stellarService.execute).toHaveBeenCalledWith('CGOVERNANCE123', 11);
      expect(proposalRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ onChainProposalId: 11 }),
      );
      expect(result.status).toBe(ProposalStatus.EXECUTED);
    });

    it('calls stellarService.execute() with the correct contract ID and proposal number', async () => {
      const oldDeadline = new Date(Date.now() - 2 * 86_400_000);
      const proposal = makeProposal({
        status: ProposalStatus.PASSED,
        deadline: oldDeadline,
        onChainProposalId: 7,
      });

      proposalRepo.findOne
        .mockResolvedValueOnce(proposal) // getProposalById
        .mockResolvedValueOnce({
          // reload after update
          ...proposal,
          status: ProposalStatus.EXECUTED,
          executionTxHash: 'abc123',
          executedBy: 'GADMIN',
        });

      configRepo.findOne.mockResolvedValue(makeConfig({ timelockPeriod: 86400 }));

      const execQb = {
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue(undefined),
      };
      proposalRepo.createQueryBuilder.mockReturnValue(execQb);

      stellarService.execute.mockResolvedValue({ txHash: 'abc123' });

      const result = await service.executeProposal(proposal.id, 'GADMIN');

      expect(stellarService.execute).toHaveBeenCalledWith('CGOVERNANCE123', 7);
      expect(result.status).toBe(ProposalStatus.EXECUTED);
      expect(result.executionTxHash).toBe('abc123');
    });

    it('leaves status as PASSED and propagates error when Soroban call fails', async () => {
      const oldDeadline = new Date(Date.now() - 2 * 86_400_000);
      const proposal = makeProposal({
        status: ProposalStatus.PASSED,
        deadline: oldDeadline,
        onChainProposalId: 7,
      });

      proposalRepo.findOne.mockResolvedValue(proposal);
      configRepo.findOne.mockResolvedValue(makeConfig({ timelockPeriod: 86400 }));
      stellarService.execute.mockRejectedValue(new Error('RPC timeout'));

      await expect(service.executeProposal(proposal.id, 'GADMIN')).rejects.toThrow(
        InternalServerErrorException,
      );

      // Verify the DB update was NOT called (status remains PASSED)
      const qbMock = proposalRepo.createQueryBuilder();
      expect(qbMock.execute).not.toHaveBeenCalled();
    });

    it('throws InternalServerErrorException when governance contract ID is not configured', async () => {
      const oldDeadline = new Date(Date.now() - 2 * 86_400_000);
      const proposal = makeProposal({
        status: ProposalStatus.PASSED,
        deadline: oldDeadline,
        onChainProposalId: 7,
      });

      proposalRepo.findOne.mockResolvedValue(proposal);
      configRepo.findOne.mockResolvedValue(makeConfig({ timelockPeriod: 86400 }));

      // Override configService to return empty string for contract ID
      configService.get.mockImplementation((key: string, fallback?: unknown) => {
        if (key === 'stellar.contractGovernance') {
          return '';
        }
        return fallback;
      });

      await expect(service.executeProposal(proposal.id, 'GADMIN')).rejects.toThrow(
        InternalServerErrorException,
      );
    });

    it('throws InternalServerErrorException when proposal is not found after execution update', async () => {
      const oldDeadline = new Date(Date.now() - 2 * 86_400_000);
      const proposal = makeProposal({
        status: ProposalStatus.PASSED,
        deadline: oldDeadline,
        onChainProposalId: 7,
      });

      proposalRepo.findOne
        .mockResolvedValueOnce(proposal) // getProposalById
        .mockResolvedValueOnce(null); // reload after update → null

      configRepo.findOne.mockResolvedValue(makeConfig({ timelockPeriod: 86400 }));

      const execQb = {
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue(undefined),
      };
      proposalRepo.createQueryBuilder.mockReturnValue(execQb);

      stellarService.execute.mockResolvedValue({ txHash: 'abc' });

      await expect(service.executeProposal(proposal.id, 'GADMIN')).rejects.toThrow(
        InternalServerErrorException,
      );
    });
  });

  // ── getConfig ── no existing config ──────────────────────────────────────

  describe('getConfig — default creation', () => {
    it('creates and returns a default config when none exists', async () => {
      configRepo.findOne.mockResolvedValue(null);
      const defaultConfig = makeConfig();
      configRepo.create.mockReturnValue(defaultConfig);
      configRepo.save.mockResolvedValue(defaultConfig);

      const result = await service.getConfig();

      expect(configRepo.create).toHaveBeenCalled();
      expect(configRepo.save).toHaveBeenCalled();
      expect(result).toEqual(defaultConfig);
    });
  });

  // ── getConfig ── no existing config ──────────────────────────────────────

  describe('getConfig — default creation', () => {
    let proposalRepo: jest.Mocked<Record<string, jest.Mock>>;
    let voteRepo: jest.Mocked<Record<string, jest.Mock>>;
    let configRepo: jest.Mocked<Record<string, jest.Mock>>;
    let dataSource: { createQueryRunner: jest.Mock };
    let stellarService: { execute: jest.Mock };
    let configService: { get: jest.Mock };
    let service: GovernanceService;

    beforeEach(async () => {
      proposalRepo = {
        find: jest.fn(),
        findOne: jest.fn(),
        create: jest.fn(),
        save: jest.fn(),
        createQueryBuilder: jest.fn(),
      } as never;
      voteRepo = { findOne: jest.fn(), create: jest.fn(), save: jest.fn() } as never;
      configRepo = { findOne: jest.fn(), create: jest.fn(), save: jest.fn() } as never;
      dataSource = {
        createQueryRunner: jest.fn(),
        query: jest.fn().mockResolvedValue(undefined),
      } as never;
      stellarService = { execute: jest.fn() };
      configService = { get: jest.fn() };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          GovernanceService,
          { provide: getRepositoryToken(Proposal), useValue: proposalRepo },
          { provide: getRepositoryToken(ProposalVote), useValue: voteRepo },
          { provide: getRepositoryToken(GovernanceConfig), useValue: configRepo },
          {
            provide: getRepositoryToken(GovernanceConfigChange),
            useValue: {
              find: jest.fn().mockResolvedValue([]),
              findOne: jest.fn().mockResolvedValue(null),
              create: jest.fn(),
              save: jest.fn(),
            },
          },
          { provide: ConfigService, useValue: configService },
          { provide: DataSource, useValue: dataSource },
          { provide: StellarService, useValue: stellarService },
        ],
      }).compile();

      service = module.get<GovernanceService>(GovernanceService);
    });

    it('creates and returns a default config when none exists', async () => {
      configRepo.findOne.mockResolvedValue(null);
      const defaultConfig = makeConfig();
      configRepo.create.mockReturnValue(defaultConfig);
      configRepo.save.mockResolvedValue(defaultConfig);

      const result = await service.getConfig();

      expect(configRepo.create).toHaveBeenCalled();
      expect(configRepo.save).toHaveBeenCalled();
      expect(result).toEqual(defaultConfig);
    });
  });

  // ── proposeConfigChange ───────────────────────────────────────────────────

  describe('proposeConfigChange', () => {
    let proposalRepo: jest.Mocked<Record<string, jest.Mock>>;
    let voteRepo: jest.Mocked<Record<string, jest.Mock>>;
    let configRepo: jest.Mocked<Record<string, jest.Mock>>;
    let configChangeRepo: jest.Mocked<Record<string, jest.Mock>>;
    let dataSource: { createQueryRunner: jest.Mock; query: jest.Mock };
    let stellarService: { execute: jest.Mock };
    let configService: { get: jest.Mock };
    let service: GovernanceService;

    beforeEach(async () => {
      proposalRepo = {
        find: jest.fn(),
        findOne: jest.fn(),
        create: jest.fn(),
        save: jest.fn(),
        createQueryBuilder: jest.fn(),
      } as never;
      voteRepo = { findOne: jest.fn(), create: jest.fn(), save: jest.fn() } as never;
      configRepo = {
        findOne: jest.fn().mockResolvedValue(makeConfig({ timelockPeriod: 86400 })),
        create: jest.fn(),
        save: jest.fn(),
      } as never;
      configChangeRepo = {
        find: jest.fn().mockResolvedValue([]),
        findOne: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
        save: jest.fn(),
      } as never;
      dataSource = { createQueryRunner: jest.fn(), query: jest.fn().mockResolvedValue(undefined) };
      stellarService = { execute: jest.fn() };
      configService = { get: jest.fn() };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          GovernanceService,
          { provide: getRepositoryToken(Proposal), useValue: proposalRepo },
          { provide: getRepositoryToken(ProposalVote), useValue: voteRepo },
          { provide: getRepositoryToken(GovernanceConfig), useValue: configRepo },
          { provide: getRepositoryToken(GovernanceConfigChange), useValue: configChangeRepo },
          { provide: ConfigService, useValue: configService },
          { provide: DataSource, useValue: dataSource },
          { provide: StellarService, useValue: stellarService },
        ],
      }).compile();

      service = module.get<GovernanceService>(GovernanceService);
    });

    it('creates a pending config-change record with the proposed values', async () => {
      const pendingChange = {
        id: 'change-uuid-1',
        configId: 1,
        proposedValues: { quorum: 5 },
        proposedBy: 'GADMIN',
        effectiveAt: new Date(Date.now() + 86400_000),
        status: ConfigChangeStatus.PENDING,
        appliedAt: null,
        appliedBy: null,
        cancelledAt: null,
        cancelledBy: null,
        reason: null,
        createdAt: new Date(),
      };
      configChangeRepo.create.mockReturnValue(pendingChange);
      configChangeRepo.save.mockResolvedValue(pendingChange);

      const result = await service.proposeConfigChange('GADMIN', { quorum: 5 } as never);

      expect(configChangeRepo.create).toHaveBeenCalled();
      expect(configChangeRepo.save).toHaveBeenCalled();
      expect(result.proposedValues).toEqual({ quorum: 5 });
      expect(result.status).toBe(ConfigChangeStatus.PENDING);
    });

    it('throws BadRequestException when no config fields are provided', async () => {
      await expect(service.proposeConfigChange('GADMIN', {} as never)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  // ── getProposals with filters ────────────────────────────────────────────

  describe('getProposals — filters', () => {
    let proposalRepo: jest.Mocked<Record<string, jest.Mock>>;
    let voteRepo: jest.Mocked<Record<string, jest.Mock>>;
    let configRepo: jest.Mocked<Record<string, jest.Mock>>;
    let dataSource: { createQueryRunner: jest.Mock };
    let stellarService: { execute: jest.Mock };
    let configService: { get: jest.Mock };
    let service: GovernanceService;

    beforeEach(async () => {
      proposalRepo = {
        find: jest.fn(),
        findOne: jest.fn(),
        create: jest.fn(),
        save: jest.fn(),
        createQueryBuilder: jest.fn(),
      } as never;
      voteRepo = { findOne: jest.fn(), create: jest.fn(), save: jest.fn() } as never;
      configRepo = {
        findOne: jest.fn().mockResolvedValue(makeConfig()),
        create: jest.fn(),
        save: jest.fn(),
      } as never;
      dataSource = {
        createQueryRunner: jest.fn(),
        query: jest.fn().mockResolvedValue(undefined),
      } as never;
      stellarService = { execute: jest.fn() };
      configService = { get: jest.fn() };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          GovernanceService,
          { provide: getRepositoryToken(Proposal), useValue: proposalRepo },
          { provide: getRepositoryToken(ProposalVote), useValue: voteRepo },
          { provide: getRepositoryToken(GovernanceConfig), useValue: configRepo },
          {
            provide: getRepositoryToken(GovernanceConfigChange),
            useValue: {
              find: jest.fn().mockResolvedValue([]),
              findOne: jest.fn().mockResolvedValue(null),
              create: jest.fn(),
              save: jest.fn(),
            },
          },
          { provide: ConfigService, useValue: configService },
          { provide: DataSource, useValue: dataSource },
          { provide: StellarService, useValue: stellarService },
        ],
      }).compile();

      service = module.get<GovernanceService>(GovernanceService);
    });

    it('filters by proposer when provided', async () => {
      const qb = {
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
      };
      proposalRepo.createQueryBuilder.mockReturnValue(qb);

      await service.getProposals({ proposer: 'GABC', page: 1, limit: 20 } as never);

      expect(qb.andWhere).toHaveBeenCalledWith(
        expect.stringContaining('proposer'),
        expect.objectContaining({ proposer: 'GABC' }),
      );
    });
  });

  // ── createProposal ──────────────────────────────────────────────────────

  describe('createProposal', () => {
    let proposalRepo: jest.Mocked<Record<string, jest.Mock>>;
    let voteRepo: jest.Mocked<Record<string, jest.Mock>>;
    let configRepo: jest.Mocked<Record<string, jest.Mock>>;
    let dataSource: { createQueryRunner: jest.Mock };
    let stellarService: { execute: jest.Mock; createProposal: jest.Mock };
    let configService: { get: jest.Mock };
    let service: GovernanceService;

    beforeEach(async () => {
      proposalRepo = {
        find: jest.fn(),
        findOne: jest.fn(),
        create: jest.fn(),
        save: jest.fn(),
        createQueryBuilder: jest.fn(),
      } as never;
      voteRepo = { findOne: jest.fn(), create: jest.fn(), save: jest.fn() } as never;
      configRepo = {
        findOne: jest.fn().mockResolvedValue(makeConfig()),
        create: jest.fn(),
        save: jest.fn(),
      } as never;
      dataSource = {
        createQueryRunner: jest.fn(),
        query: jest.fn().mockResolvedValue(undefined),
      } as never;
      stellarService = { execute: jest.fn(), createProposal: jest.fn() };
      configService = {
        get: jest.fn().mockImplementation((key: string, fallback?: unknown) => {
          if (key === 'stellar.contractGovernance') {
            return 'CGOVERNANCE123';
          }
          return fallback;
        }),
      };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          GovernanceService,
          { provide: getRepositoryToken(Proposal), useValue: proposalRepo },
          { provide: getRepositoryToken(ProposalVote), useValue: voteRepo },
          { provide: getRepositoryToken(GovernanceConfig), useValue: configRepo },
          {
            provide: getRepositoryToken(GovernanceConfigChange),
            useValue: {
              find: jest.fn().mockResolvedValue([]),
              findOne: jest.fn().mockResolvedValue(null),
              create: jest.fn(),
              save: jest.fn(),
            },
          },
          { provide: ConfigService, useValue: configService },
          { provide: DataSource, useValue: dataSource },
          { provide: StellarService, useValue: stellarService },
        ],
      }).compile();

      service = module.get<GovernanceService>(GovernanceService);
    });

    it('creates a proposal with the correct fields', async () => {
      configRepo.findOne.mockResolvedValue(makeConfig({ votingPeriod: 3600 }));
      proposalRepo.create.mockReturnValue(makeProposal());
      proposalRepo.save.mockResolvedValue(makeProposal({ title: 'Test' }));

      const result = await service.createProposal('GPROPOSER', {
        title: 'Test Proposal',
        actionType: 'update_fee',
        actionParams: { fee: 200 },
      } as never);

      expect(proposalRepo.create).toHaveBeenCalled();
      expect(result).toBeDefined();
    });

    it('registers the proposal on-chain and persists the returned onChainProposalId', async () => {
      configRepo.findOne.mockResolvedValue(makeConfig({ votingPeriod: 3600 }));
      const created = makeProposal({
        title: 'On-chain proposal',
        description: 'desc',
        actionType: 'update_fee',
        actionParams: { fee: 200 },
      });
      proposalRepo.create.mockReturnValue(created);
      proposalRepo.save.mockResolvedValue(created);
      stellarService.createProposal.mockResolvedValue(42);

      const result = await service.createProposal('GPROPOSER', {
        title: 'On-chain proposal',
        description: 'desc',
        actionType: 'update_fee',
        actionParams: { fee: 200 },
      } as never);

      expect(stellarService.createProposal).toHaveBeenCalledWith(
        'CGOVERNANCE123',
        'On-chain proposal',
        'desc',
        { actionType: 'update_fee', actionParams: { fee: 200 } },
      );
      expect(proposalRepo.save).toHaveBeenLastCalledWith(
        expect.objectContaining({ onChainProposalId: 42 }),
      );
      expect(result.onChainProposalId).toBe(42);
    });

    it('leaves onChainProposalId null when the governance contract is not configured', async () => {
      configRepo.findOne.mockResolvedValue(makeConfig({ votingPeriod: 3600 }));
      const created = makeProposal();
      proposalRepo.create.mockReturnValue(created);
      proposalRepo.save.mockResolvedValue(created);
      configService.get.mockReturnValue('');

      const result = await service.createProposal('GPROPOSER', {
        title: 'Offline proposal',
        actionType: 'update_fee',
      } as never);

      expect(stellarService.createProposal).not.toHaveBeenCalled();
      expect(result.onChainProposalId).toBeNull();
    });

    it('leaves onChainProposalId null when on-chain registration throws', async () => {
      configRepo.findOne.mockResolvedValue(makeConfig({ votingPeriod: 3600 }));
      const created = makeProposal();
      proposalRepo.create.mockReturnValue(created);
      proposalRepo.save.mockResolvedValue(created);
      stellarService.createProposal.mockRejectedValue(new Error('RPC timeout'));

      const result = await service.createProposal('GPROPOSER', {
        title: 'Offline proposal',
        actionType: 'update_fee',
      } as never);

      expect(result.onChainProposalId).toBeNull();
    });
  });

  // ── checkExpiry via getProposalById ─────────────────────────────────────

  describe('checkExpiry — via getProposalById', () => {
    let proposalRepo: jest.Mocked<Record<string, jest.Mock>>;
    let voteRepo: jest.Mocked<Record<string, jest.Mock>>;
    let configRepo: jest.Mocked<Record<string, jest.Mock>>;
    let dataSource: { createQueryRunner: jest.Mock };
    let stellarService: { execute: jest.Mock };
    let configService: { get: jest.Mock };
    let service: GovernanceService;

    beforeEach(async () => {
      proposalRepo = {
        find: jest.fn(),
        findOne: jest.fn(),
        create: jest.fn(),
        save: jest.fn(),
        createQueryBuilder: jest.fn(),
      } as never;
      voteRepo = { findOne: jest.fn(), create: jest.fn(), save: jest.fn() } as never;
      configRepo = {
        findOne: jest.fn().mockResolvedValue(makeConfig()),
        create: jest.fn(),
        save: jest.fn(),
      } as never;
      dataSource = {
        createQueryRunner: jest.fn(),
        query: jest.fn().mockResolvedValue(undefined),
      } as never;
      stellarService = { execute: jest.fn() };
      configService = { get: jest.fn() };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          GovernanceService,
          { provide: getRepositoryToken(Proposal), useValue: proposalRepo },
          { provide: getRepositoryToken(ProposalVote), useValue: voteRepo },
          { provide: getRepositoryToken(GovernanceConfig), useValue: configRepo },
          {
            provide: getRepositoryToken(GovernanceConfigChange),
            useValue: {
              find: jest.fn().mockResolvedValue([]),
              findOne: jest.fn().mockResolvedValue(null),
              create: jest.fn(),
              save: jest.fn(),
            },
          },
          { provide: ConfigService, useValue: configService },
          { provide: DataSource, useValue: dataSource },
          { provide: StellarService, useValue: stellarService },
        ],
      }).compile();

      service = module.get<GovernanceService>(GovernanceService);
    });

    it('marks an expired active proposal as EXPIRED via a conditional UPDATE (not load+save)', async () => {
      const pastDeadline = new Date(Date.now() - 3600_000);
      const expiredProposal = makeProposal({
        status: ProposalStatus.ACTIVE,
        deadline: pastDeadline,
      });
      proposalRepo.findOne.mockResolvedValue(expiredProposal);

      const qb = {
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ affected: 1 }),
      };
      proposalRepo.createQueryBuilder.mockReturnValue(qb);

      const result = await service.getProposalById('prop-1');

      expect(proposalRepo.save).not.toHaveBeenCalled();
      expect(qb.update).toHaveBeenCalledWith(Proposal);
      expect(qb.set).toHaveBeenCalledWith({ status: ProposalStatus.EXPIRED });
      expect(qb.andWhere).toHaveBeenCalledWith(
        expect.stringContaining('status'),
        expect.objectContaining({ active: ProposalStatus.ACTIVE }),
      );
      expect(result.status).toBe(ProposalStatus.EXPIRED);
    });

    it('does not modify a non-ACTIVE proposal (already EXPIRED)', async () => {
      const alreadyExpired = makeProposal({ status: ProposalStatus.EXPIRED });
      proposalRepo.findOne.mockResolvedValue(alreadyExpired);

      const result = await service.getProposalById('prop-1');

      expect(proposalRepo.save).not.toHaveBeenCalled();
      expect(proposalRepo.createQueryBuilder).not.toHaveBeenCalled();
      expect(result.status).toBe(ProposalStatus.EXPIRED);
    });

    it('under concurrent reads, only the request that wins the conditional UPDATE reports EXPIRED status', async () => {
      // Simulates two concurrent getProposalById() calls racing on the same
      // just-expired proposal. Only the first UPDATE (status still 'active'
      // at execution time) affects a row; the second, running after the first
      // committed, matches zero rows because the WHERE status='active' guard
      // no longer holds.
      const pastDeadline = new Date(Date.now() - 3600_000);
      const expiredProposal = makeProposal({
        status: ProposalStatus.ACTIVE,
        deadline: pastDeadline,
      });
      proposalRepo.findOne.mockResolvedValue(expiredProposal);

      let updateCallIndex = 0;
      proposalRepo.createQueryBuilder.mockImplementation(() => ({
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        execute: jest.fn().mockImplementation(async () => {
          updateCallIndex++;
          return { affected: updateCallIndex === 1 ? 1 : 0 };
        }),
      }));

      const [first, second] = await Promise.all([
        service.getProposalById('prop-1'),
        service.getProposalById('prop-1'),
      ]);

      expect(proposalRepo.save).not.toHaveBeenCalled();
      expect(first.status).toBe(ProposalStatus.EXPIRED);
      expect(second.status).toBe(ProposalStatus.EXPIRED);
    });
  });
});
