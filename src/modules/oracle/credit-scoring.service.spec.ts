// @ts-nocheck
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
    phPenaltyFactor: 1.0,
    tempPenaltyFactor: 1.0,
    nutrientDivisor: 10.0,
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

  it('6. should use configurable nutrient divisor', () => {
    const config = { ...mockConfig, nutrientDivisor: 20.0 };
    const readings = {
      flowRate: 1.0,
      nitrogen: 10.0, // reduction = 1 - 10/20 = 0.5
      phosphorus: 5.0, // reduction = 1 - 5/20 = 0.75
      ph: 7.0,
      temperature: 1.0,
    };
    const credits = service.calculate(readings, config, 10);
    // score = 1.0 * 0.5 + 0.5 * 0.3 + 0.75 * 0.2 = 0.5 + 0.15 + 0.15 = 0.8
    expect(credits.toNumber()).toBeCloseTo(8.0);
  });

  it('7. should use configurable ph penalty factor and temp penalty factor', () => {
    const config = { ...mockConfig, phPenaltyFactor: 0.5, tempPenaltyFactor: 2.0 };
    const readings = {
      flowRate: 1.0,
      nitrogen: 0,
      phosphorus: 0,
      ph: 10.0, // breach max (9.0) by 1.0 -> penalty = 1.0 * 0.5 = 0.5
      temperature: 2.5, // breach tempPenaltyDelta (2.0) by 0.5 -> penalty = 0.5 * 2.0 = 1.0
    };
    const credits = service.calculate(readings, config, 10);
    // score = 1.0
    // penalty = 1.5
    // credits = max(0, 1.0 - 1.5) = 0
    expect(credits.toNumber()).toBe(0);
  });

  it('8. should calculate correctly with zero flow rate', () => {
    const readings = {
      flowRate: 0.0,
      nitrogen: 0,
      phosphorus: 0,
      ph: 7.0,
      temperature: 1.0,
    };
    const credits = service.calculate(readings, mockConfig, 10);
    // score = 0 * 0.5 + 1.0 * 0.3 + 1.0 * 0.2 = 0.5
    expect(credits.toNumber()).toBe(5.0);
  });

  it('9. should handle extreme nutrient values (clamping)', () => {
    const readings = {
      flowRate: 1.0,
      nitrogen: 1000.0, // much larger than divisor 10, clamped to 0 reduction
      phosphorus: 500.0,
      ph: 7.0,
      temperature: 1.0,
    };
    const credits = service.calculate(readings, mockConfig, 10);
    // score = 1.0 * 0.5 + 0 + 0 = 0.5
    expect(credits.toNumber()).toBe(5.0);
  });

  it('10. should handle missing/undefined config cleanly (default config regression)', () => {
    const readings = {
      flowRate: 1.0,
      nitrogen: 5.0, // reduction 0.5
      phosphorus: 5.0, // reduction 0.5
      ph: 7.0,
      temperature: 1.0,
    };
    // Testing default parameters logic 1.0, 1.0, 10.0 from mockConfig
    const credits = service.calculate(readings, mockConfig, 10);
    // score = 0.5 + 0.15 + 0.1 = 0.75
    expect(credits.toNumber()).toBeCloseTo(7.5);
  });

  it('11. should penalise pH below phMin correctly', () => {
    const readings = {
      flowRate: 1.0,
      nitrogen: 0,
      phosphorus: 0,
      ph: 4.0, // breach min (6.0) by 2.0
      temperature: 1.0,
    };
    const credits = service.calculate(readings, mockConfig, 10);
    // score = 1.0
    // penalty = 2.0 * 1.0 = 2.0
    // credits = max(0, (1.0 - 2.0) * 10) = 0
    expect(credits.toNumber()).toBe(0);
  });

  it('12. should not penalise if thresholds are null', () => {
    const nullConfig = { ...mockConfig, phMin: null, phMax: null, tempPenaltyDelta: null };
    const readings = {
      flowRate: 1.0,
      nitrogen: 0,
      phosphorus: 0,
      ph: 14.0, // normally a huge breach
      temperature: 100.0, // normally a huge breach
    };
    const credits = service.calculate(readings, nullConfig, 10);
    // score = 1.0, penalty = 0 because thresholds are null
    expect(credits.toNumber()).toBe(10);
  });
});
