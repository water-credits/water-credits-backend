import { Test, TestingModule } from '@nestjs/testing';
import { CreditScoringService } from './credit-scoring.service';
import { GovernanceConfig } from '../governance/entities/governance-config.entity';
// import { BigNumber } from 'bignumber.js';

describe('CreditScoringService', () => {
  let service: CreditScoringService;

  const mockConfig: GovernanceConfig = {
    id: 1,
    protocolFeeBps: 100,
    minOracleConfirmations: 3,
    votingPeriod: 604800,
    timelockPeriod: 86400,
    quorum: 3,
    phMin: 6.0,
    phMax: 9.0,
    doThreshold: 5.0,
    tempPenaltyDelta: 2.0,
    weightVolumetric: 0.5,
    weightNitrogen: 0.3,
    weightPhosphorus: 0.2,
    updatedBy: null,
    updatedAt: new Date(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [CreditScoringService],
    }).compile();

    service = module.get<CreditScoringService>(CreditScoringService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('1. should calculate correct credits for ideal water quality', () => {
    const readings = {
      flowRate: 1.0,
      nitrogen: 0,
      phosphorus: 0,
      ph: 7.0, // perfect pH
      temperature: 1.0, // below tempPenaltyDelta
    };

    const credits = service.calculate(readings, mockConfig, 10);
    // score = 1.0 * 0.5 + 1.0 * 0.3 + 1.0 * 0.2 = 1.0
    // penalty = 0
    // credits = 1.0 * 10 = 10
    expect(credits.toNumber()).toBe(10);
  });

  it('2. should calculate correct credits with pH breach penalty', () => {
    const readings = {
      flowRate: 1.0,
      nitrogen: 0,
      phosphorus: 0,
      ph: 10.0, // breach max (9.0) by 1.0
      temperature: 1.0,
    };

    const credits = service.calculate(readings, mockConfig, 10);
    // score = 1.0
    // penalty = 1.0 * 1.0 = 1.0
    // credits = (1.0 - 1.0) * 10 = 0
    expect(credits.toNumber()).toBe(0);
  });

  it('3. should calculate correct credits for low flow rate', () => {
    const readings = {
      flowRate: 0.5,
      nitrogen: 0,
      phosphorus: 0,
      ph: 7.0,
      temperature: 1.0,
    };

    const credits = service.calculate(readings, mockConfig, 10);
    // score = 0.5 * 0.5 + 1.0 * 0.3 + 1.0 * 0.2 = 0.25 + 0.3 + 0.2 = 0.75
    // credits = 0.75 * 10 = 7.5
    expect(credits.toNumber()).toBeCloseTo(7.5);
  });

  it('4. should calculate correct credits for all-null readings', () => {
    const readings = {};

    const credits = service.calculate(readings, mockConfig, 10);
    // score = 0 * 0.5 + 1 * 0.3 + 1 * 0.2 = 0.5
    // ph is 0, breach min (6.0) by 6.0
    // penalty = 6.0
    // credits = max(0, 0.5 - 6.0) = 0
    expect(credits.toNumber()).toBe(0);
  });

  it('5. should calculate correct credits with high temperature penalty', () => {
    const readings = {
      flowRate: 1.0,
      nitrogen: 0,
      phosphorus: 0,
      ph: 7.0,
      temperature: 2.5, // breach tempPenaltyDelta (2.0) by 0.5
    };

    const credits = service.calculate(readings, mockConfig, 10);
    // score = 1.0
    // penalty = 0.5 * 1.0 = 0.5
    // credits = (1.0 - 0.5) * 10 = 5.0
    expect(credits.toNumber()).toBe(5);
  });
});
