import { Injectable } from '@nestjs/common';
import { GovernanceConfig } from '../governance/entities/governance-config.entity';
import { BigNumber } from 'bignumber.js';

@Injectable()
export class CreditScoringService {
  /**
   * Calculates the credits generated for a given set of sensor readings.
   *
   * Formula:
   * score = clamp(flow_rate, 0, 1) * weightVolumetric
   *       + nitrogenReduction() * weightNitrogen
   *       + phosphorusReduction() * weightPhosphorus
   *
   * penalty = max(0, phDeviation - tolerance) * phPenaltyFactor
   *         + max(0, tempDeviation - tempPenaltyDelta) * tempPenaltyFactor
   *
   * creditsGenerated = max(0, (score - penalty) * areaHectares * scalingFactor)
   */
  calculate(
    readingsSnapshot: Record<string, unknown>,
    config: GovernanceConfig,
    areaHectares: number,
  ): BigNumber {
    const coerce = (v: unknown): number => {
      if (typeof v === 'number') return v;
      if (typeof v === 'string') return parseFloat(v) || 0;
      return 0;
    };

    const flowRate = coerce(readingsSnapshot['flowRate'] ?? readingsSnapshot['flow_rate']);
    const nitrogen = coerce(readingsSnapshot['nitrogen']);
    const phosphorus = coerce(readingsSnapshot['phosphorus']);
    const ph = coerce(readingsSnapshot['ph']);
    const temperature = coerce(readingsSnapshot['temperature']);

    // Helper to clamp values between 0 and 1
    const clamp = (val: number, min: number, max: number) => Math.max(min, Math.min(max, val));

    // Placeholders for reduction logic - assuming lower is better, clamping 1 - value/10
    const nitrogenReduction = () => clamp(1 - nitrogen / 10, 0, 1);
    const phosphorusReduction = () => clamp(1 - phosphorus / 10, 0, 1);

    // Score Calculation
    const volumetricScore = new BigNumber(clamp(flowRate, 0, 1)).multipliedBy(
      config.weightVolumetric,
    );
    const nitrogenScore = new BigNumber(nitrogenReduction()).multipliedBy(config.weightNitrogen);
    const phosphorusScore = new BigNumber(phosphorusReduction()).multipliedBy(
      config.weightPhosphorus,
    );

    const score = volumetricScore.plus(nitrogenScore).plus(phosphorusScore);

    // Penalty Calculation
    const phPenaltyFactor = 1.0; // Placeholder until defined in GovernanceConfig
    const tempPenaltyFactor = 1.0; // Placeholder until defined in GovernanceConfig

    let phDeviation = 0;
    if (config.phMin != null && ph < config.phMin) {
      phDeviation = config.phMin - ph;
    } else if (config.phMax != null && ph > config.phMax) {
      phDeviation = ph - config.phMax;
    }

    let tempDeviation = 0;
    if (config.tempPenaltyDelta != null && temperature > config.tempPenaltyDelta) {
      // Assuming tempPenaltyDelta acts as a threshold or max allowed
      tempDeviation = temperature - config.tempPenaltyDelta;
    }

    const phPenalty = new BigNumber(Math.max(0, phDeviation)).multipliedBy(phPenaltyFactor);
    const tempPenalty = new BigNumber(Math.max(0, tempDeviation)).multipliedBy(tempPenaltyFactor);

    const penalty = phPenalty.plus(tempPenalty);

    // Total Calculation
    const scalingFactor = 1.0; // Standardize to 1.0 until specific logic is provided
    const rawCredits = score.minus(penalty).multipliedBy(areaHectares).multipliedBy(scalingFactor);

    // Prevent negative credits
    return BigNumber.maximum(0, rawCredits);
  }
}
